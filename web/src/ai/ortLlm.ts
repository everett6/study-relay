// Custom low-VRAM ONNX Runtime WebGPU runner for causal LMs (LFM3, Qwen, Llama, etc.).
// Bypasses transformers.js's DynamicCache & full-sequence logits retention by:
//   1. Disabling ORT's memory-pattern arena (prevents retaining peak activation buffers).
//   2. Keeping KV/conv state tensors zero-copy on gpu-buffer across steps.
//   3. Prefilling prompts in bounded chunks (64 tokens) to cap peak attention/logits VRAM.
//   4. Immediately .dispose()-ing every replaced GPU state tensor and logits tensor, and
//      clearing all state buffers in finally{} when generation finishes.

import * as ort from "onnxruntime-web/webgpu";

export interface StatePair { past: string; present: string }

export interface InputMeta {
  readonly name: string;
  readonly shape?: ReadonlyArray<number | string>;
  readonly type?: string;
}

export interface LowVramSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly inputMetadata?: readonly InputMeta[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
}

export interface GenerateOpts {
  maxNewTokens?: number;
  repetitionPenalty?: number;
  chunkSize?: number;
  maxPromptTokens?: number;
  eosIds?: Iterable<number>;
  numHeads?: number;
  numKeyValueHeads?: number;
  headDim?: number;
  hiddenSize?: number;
  createTensor?: (type: ort.Tensor.Type, data: ort.Tensor.DataType, dims: readonly number[]) => ort.Tensor;
  /** Prefix KV cache: the first `prefix.ids.length` prompt tokens (the fixed instructions).
   *  With `prefix.state` set and a matching prompt, prefill starts after the prefix.
   *  Without it, the prefix is prefilled and its state is handed to `onPrefix` for next time. */
  prefix?: { ids: number[]; state?: CachedState };
  onPrefix?: (s: CachedState) => void;
}

/** Model state after a prompt prefix, copied to CPU memory (float32 quantized to float16 for 2x compression). */
export interface CachedState { len: number; tensors: Record<string, { type: ort.Tensor.Type; data: ort.Tensor.DataType; dims: readonly number[]; f16?: boolean }>; bytes: number }

export const startsWith = (a: number[], p: number[]) => p.length <= a.length && p.every((v, i) => a[i] === v);

/** Detect WebGPU fp16 support, buffer limits, and Chromebook/Safari/low-RAM constraints. */
export async function detectWebGPUConfig(): Promise<{
  device: "webgpu" | "wasm";
  dtype: "q4f16" | "q4";
  hasF16: boolean;
  chunkSize: number;
  maxPromptTokens: number;
}> {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isConstrained = /\bCrOS\b/i.test(ua) || (/Safari/i.test(ua) && !/Chrome|Chromium/i.test(ua))
    || ((typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined) ?? 8) <= 4;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<{ features?: { has(f: string): boolean }; limits?: { maxBufferSize?: number } } | null> } }).gpu;
    // the GPU can be briefly unavailable (sleep, GPU-process restart): retry before falling back to CPU
    let adapter = null;
    for (const [i, o] of [{ powerPreference: "high-performance" }, undefined, { powerPreference: "low-power" }].entries()) {
      adapter = await gpu?.requestAdapter(o).catch(() => null) ?? null;
      if (adapter || !gpu) break;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    if (!adapter) {
      return { device: "wasm", dtype: "q4", hasF16: false, chunkSize: 16, maxPromptTokens: 1024 };
    }
    const hasF16 = !!adapter.features?.has("shader-f16");
    const maxBuf = adapter.limits?.maxBufferSize ?? 0;
    const lowBuf = maxBuf > 0 && maxBuf < 1024 * 1024 * 1024;
    return {
      device: "webgpu",
      dtype: hasF16 ? "q4f16" : "q4",
      hasF16,
      chunkSize: isConstrained || lowBuf ? 16 : 64,
      maxPromptTokens: isConstrained || lowBuf ? 1024 : 1536,
    };
  } catch {
    return { device: "wasm", dtype: "q4", hasF16: false, chunkSize: 16, maxPromptTokens: 1024 };
  }
}

/** ORT WebGPU session options tuned to minimize retained VRAM and CPU arena overhead. */
export function lowVramSessionOptions(): ort.InferenceSession.SessionOptions {
  return {
    enableMemPattern: false,
    enableCpuMemArena: false,
    graphOptimizationLevel: "all",
    executionMode: "sequential",
    freeDimensionOverrides: { batch_size: 1 },
    preferredOutputLocation: "gpu-buffer",
  };
}

/** Match past_* state inputs to present* outputs (handles past_key_values.* and past_conv.*). */
export function mapStatePairs(inputNames: readonly string[], outputNames: readonly string[]): StatePair[] {
  const outSet = new Set(outputNames);
  const pairs: StatePair[] = [];
  for (const past of inputNames) {
    if (!past.startsWith("past")) continue;
    const candidates = [
      past.replace(/^past_key_values\./, "present."),
      past.replace(/^past_/, "present_"),
      past.replace(/^past/, "present"),
    ];
    const present = candidates.find((c) => outSet.has(c));
    if (present) pairs.push({ past, present });
  }
  return pairs;
}

/** Convert float32 to IEEE 754 binary16 (uint16) for 2x prefix KV cache compression. */
export function f32ToF16(val: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let mant = (x >> 13) & 0x3ff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x400) >> (1 - exp);
    return sign | mant;
  }
  if (exp >= 31) return sign | 0x7c00 | (mant ? 1 : 0);
  return sign | (exp << 10) | mant;
}

/** Convert IEEE 754 binary16 (uint16) to float32. */
export function f16ToF32(h: number): number {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

/** Greedy argmax on the last token's logits with HuggingFace-style repetition penalty. */
export function sampleNextToken(
  data: Float32Array | Uint16Array | ArrayLike<number>,
  type: string,
  vocabSize: number,
  seen: Set<number>,
  repetitionPenalty = 1.1,
): number {
  const start = Math.max(0, data.length - vocabSize);
  const isF16 = type === "float16" || data instanceof Uint16Array;
  let bestId = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < vocabSize; i++) {
    let v = isF16 ? f16ToF32(data[start + i] as number) : Number(data[start + i]);
    if (repetitionPenalty !== 1 && seen.has(i)) {
      v = v < 0 ? v * repetitionPenalty : v / repetitionPenalty;
    }
    if (v > bestScore) {
      bestScore = v;
      bestId = i;
    }
  }
  return bestId;
}

function typedZeroBuffer(type: string, len: number): Float32Array | Uint16Array | Int32Array | BigInt64Array {
  switch (type) {
    case "float16": return new Uint16Array(len);
    case "int64": return new BigInt64Array(len);
    case "int32": return new Int32Array(len);
    default: return new Float32Array(len);
  }
}

function initEmptyState(
  session: LowVramSession,
  pairs: StatePair[],
  opts: GenerateOpts,
  mkTensor: (type: ort.Tensor.Type, data: ort.Tensor.DataType, dims: readonly number[]) => ort.Tensor,
): Record<string, ort.Tensor> {
  const metaMap = new Map((session.inputMetadata ?? []).map((m) => [m.name, m]));
  const symbols: Record<string, number> = { batch_size: 1 };
  if (typeof opts.numHeads === "number") {
    symbols["batch_size x num_heads"] = opts.numHeads;
    symbols["num_heads"] = opts.numHeads;
  }
  if (typeof opts.numKeyValueHeads === "number") {
    symbols["num_key_value_heads"] = opts.numKeyValueHeads;
    symbols["batch_size x num_key_value_heads"] = opts.numKeyValueHeads;
  }
  if (typeof opts.headDim === "number") symbols["head_dim"] = opts.headDim;
  if (typeof opts.hiddenSize === "number") symbols["hidden_size"] = opts.hiddenSize;
  const state: Record<string, ort.Tensor> = {};
  for (const { past } of pairs) {
    const meta = metaMap.get(past);
    if (!meta?.shape) throw new Error(`missing inputMetadata for ${past}`);
    const dims = meta.shape.map((d) => (typeof d === "number" ? d : (symbols[d] ?? 0)));
    const dtype = (meta.type ?? "float32") as ort.Tensor.Type;
    const size = dims.reduce((a, b) => a * b, 1);
    state[past] = mkTensor(dtype, typedZeroBuffer(dtype, size), dims);
  }
  return state;
}

/** Run chunked prefill + zero-leak autoregressive decode directly on an ORT WebGPU session. */
export async function generateLowVram(
  session: LowVramSession,
  promptIds: number[],
  opts: GenerateOpts = {},
): Promise<number[]> {
  const maxNew = opts.maxNewTokens ?? 400;
  const penalty = opts.repetitionPenalty ?? 1.1;
  const chunkSize = Math.max(1, opts.chunkSize ?? 64);
  const maxPrompt = Math.max(128, opts.maxPromptTokens ?? 1536);
  if (promptIds.length > maxPrompt) {
    const head = Math.floor(maxPrompt * 0.35);
    const tail = maxPrompt - head;
    promptIds = [...promptIds.slice(0, head), ...promptIds.slice(promptIds.length - tail)];
  }
  const truncated = promptIds.length >= maxPrompt;
  const prefix = opts.prefix && !truncated && opts.prefix.ids.length >= chunkSize && opts.prefix.ids.length < promptIds.length
    && startsWith(promptIds, opts.prefix.ids) ? opts.prefix : undefined;
  const eos = new Set(opts.eosIds ?? []);
  const inSet = new Set(session.inputNames);
  const hasMask = inSet.has("attention_mask");
  const hasPos = inSet.has("position_ids");
  const hasNumLogits = inSet.has("num_logits_to_keep");

  const mkTensor = opts.createTensor ?? ((type: ort.Tensor.Type, data: ort.Tensor.DataType, dims: readonly number[]) => new ort.Tensor(type, data as never, dims));
  const pairs = mapStatePairs(session.inputNames, session.outputNames);
  let state = initEmptyState(session, pairs, opts, mkTensor);
  const numLogitsMeta = session.inputMetadata?.find((m) => m.name === "num_logits_to_keep");
  const numLogitsTensor = hasNumLogits
    ? mkTensor("int64", BigInt64Array.from([1n]), (numLogitsMeta?.shape?.length ?? 0) === 1 ? [1] : [])
    : null;

  const seen = new Set(promptIds);
  const generated: number[] = [];
  let pastLen = 0;
  let start = 0;
  if (prefix?.state && prefix.state.len === prefix.ids.length) {
    // reuse: dispose empty placeholder tensors, then restore compressed CPU state to GPU
    for (const t of Object.values(state)) t?.dispose();
    state = Object.fromEntries(Object.entries(prefix.state.tensors).map(([k, t]) => {
      let data = t.data;
      if (t.f16 && t.type === "float32" && data instanceof Uint16Array) {
        const f32 = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) f32[i] = f16ToF32(data[i]);
        data = f32;
      }
      return [k, mkTensor(t.type, data, t.dims)];
    }));
    pastLen = start = prefix.state.len;
  }

  const step = async (chunk: number[]): Promise<number> => {
    const len = chunk.length;
    const feeds: Record<string, ort.Tensor> = {
      input_ids: mkTensor("int64", BigInt64Array.from(chunk, BigInt), [1, len]),
      ...state,
    };
    let maskTensor: ort.Tensor | null = null;
    let posTensor: ort.Tensor | null = null;
    if (hasMask) {
      maskTensor = mkTensor("int64", new BigInt64Array(pastLen + len).fill(1n), [1, pastLen + len]);
      feeds.attention_mask = maskTensor;
    }
    if (hasPos) {
      const pos = new BigInt64Array(len);
      for (let i = 0; i < len; i++) pos[i] = BigInt(pastLen + i);
      posTensor = mkTensor("int64", pos, [1, len]);
      feeds.position_ids = posTensor;
    }
    if (numLogitsTensor) feeds.num_logits_to_keep = numLogitsTensor;

    const out = await session.run(feeds);
    feeds.input_ids.dispose();
    maskTensor?.dispose();
    posTensor?.dispose();

    for (const { past, present } of pairs) {
      const next = out[present];
      const prev = state[past];
      if (next) {
        state[past] = next;
        if (prev && prev !== next) prev.dispose();
      }
    }

    const logits = out.logits;
    const vocabSize = logits.dims[logits.dims.length - 1];
    const data = await logits.getData(true);
    logits.dispose();
    pastLen += len;
    return sampleNextToken(data as Float32Array | Uint16Array, logits.type, vocabSize, seen, penalty);
  };

  try {
    let nextId = 0;
    if (prefix && !prefix.state && opts.onPrefix) {
      for (let i = 0; i < prefix.ids.length; i += chunkSize) await step(promptIds.slice(i, Math.min(i + chunkSize, prefix.ids.length)));
      const tensors: CachedState["tensors"] = {};
      let bytes = 0;
      for (const [k, t] of Object.entries(state)) {
        let data = await t.getData(false); // copy GPU -> CPU, keep the GPU tensor for this run
        let f16 = false;
        if (t.type === "float32" && data instanceof Float32Array) {
          const u16 = new Uint16Array(data.length);
          for (let i = 0; i < data.length; i++) u16[i] = f32ToF16(data[i]);
          data = u16;
          f16 = true;
        }
        tensors[k] = { type: t.type, data, dims: t.dims, ...(f16 ? { f16: true } : {}) };
        bytes += (data as ArrayBufferView).byteLength ?? 0;
      }
      opts.onPrefix({ len: prefix.ids.length, tensors, bytes });
      start = prefix.ids.length;
    }
    for (let i = start; i < promptIds.length; i += chunkSize) {
      nextId = await step(promptIds.slice(i, i + chunkSize));
    }
    for (let i = 0; i < maxNew; i++) {
      if (eos.has(nextId)) break;
      generated.push(nextId);
      seen.add(nextId);
      nextId = await step([nextId]);
      // Yield briefly every 8 tokens so WebGPU command bursts never freeze browser/OS compositing.
      if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
    }
    return generated;
  } finally {
    numLogitsTensor?.dispose();
    for (const t of Object.values(state)) t?.dispose();
  }
}
