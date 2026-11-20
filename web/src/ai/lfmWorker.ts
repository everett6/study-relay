// Runs Liquid's LFM3 (ONNX, q4f16/q4) on WebGPU inside a Web Worker using our custom
// low-VRAM ONNX runner (chunked prefill, zero-copy gpu-buffer state, immediate disposal).
// Same message protocol as llmWorker.ts: load / chat / cached.
import { AutoModelForCausalLM, AutoTokenizer, env, Tensor, type PreTrainedModel, type PreTrainedTokenizer } from "@huggingface/transformers";
import type * as ort from "onnxruntime-web/webgpu";
import { detectWebGPUConfig, generateLowVram, lowVramSessionOptions, type CachedState, type LowVramSession } from "./ortLlm";

env.allowLocalModels = false;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
}
let tok: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
let gpuChunkSize = 64;
let usePrefixCache = true;
let maxPromptTokens = 1536;
// prefix KV cache: system prompt text -> model state after it (CPU copy). Two entries cover the
// planner prompt plus whichever other prompt (estimate / extract / summarize) ran last.
const prefixCache = new Map<string, { ids: number[]; state?: CachedState }>();
const PREFIX_SLOTS = 2;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
self.addEventListener("unhandledrejection", (ev) => {
  ev.preventDefault();
  post({ type: "error", error: String(ev.reason || "unhandled worker rejection") });
});

// combine per-file download progress into one 0..1 number
const files = new Map<string, { loaded: number; total: number }>();
function progress(p: { status: string; file?: string; loaded?: number; total?: number }) {
  if (p.status === "progress" && p.file && p.total) {
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    post({ type: "progress", progress: Math.min(0.99, l / t), text: `Downloading LFM3: ${(l / 1e9).toFixed(2)} / ${(t / 1e9).toFixed(2)} GB` });
  } else if (p.status === "ready") post({ type: "progress", progress: 0.99, text: "Starting LFM3 on the GPU…" });
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data as { id: number; type: string };
  try {
    if (type === "load") {
      const { device, dtype, chunkSize, maxPromptTokens: detectedMax } = await detectWebGPUConfig();
      gpuChunkSize = chunkSize;
      maxPromptTokens = detectedMax;
      usePrefixCache = e.data.prefixCache !== false;
      if (Number(e.data.contextTokens) > 256) maxPromptTokens = Number(e.data.contextTokens);
      prefixCache.clear();
      tok = await AutoTokenizer.from_pretrained(e.data.model, { progress_callback: progress });
      const baseOpts = device === "webgpu"
        ? { ...lowVramSessionOptions(), preferredOutputLocation: undefined }
        : { enableMemPattern: false, enableCpuMemArena: false };
      try {
        model = await AutoModelForCausalLM.from_pretrained(e.data.model, {
          dtype,
          device,
          session_options: baseOpts,
          progress_callback: progress,
        });
      } catch (loadErr) {
        if (device === "webgpu" && dtype === "q4f16") {
          model = await AutoModelForCausalLM.from_pretrained(e.data.model, {
            dtype: "q4",
            device,
            session_options: baseOpts,
            progress_callback: progress,
          });
        } else {
          throw loadErr;
        }
      }
      post({ id, ok: true });
    } else if (type === "chat") {
      if (!tok || !model) throw new Error("model not loaded");
      const req = e.data.request as { messages: { role: string; content: string }[]; max_tokens?: number; temperature?: number; enable_thinking?: boolean; cache_prefix?: string };
      const inputs = tok.apply_chat_template(req.messages, {
        add_generation_prompt: true, return_dict: true, enable_thinking: !!req.enable_thinking,
      } as Parameters<PreTrainedTokenizer["apply_chat_template"]>[1]) as { input_ids: Tensor; attention_mask?: Tensor };
      const promptIds = Array.from(inputs.input_ids.data as BigInt64Array | Int32Array, Number);
      const n = promptIds.length;
      const sessions = (model as unknown as { sessions?: Record<string, LowVramSession> }).sessions;
      const session = sessions?.decoder_model_merged ?? sessions?.model;
      let rawText: string;
      if (session?.outputNames?.includes("logits")) {
        inputs.input_ids.dispose?.();
        inputs.attention_mask?.dispose?.();
        const cfg = model.config as unknown as {
          eos_token_id?: number | number[];
          normalized_config?: { num_heads?: number; num_kv_heads?: number };
          num_attention_heads?: number;
          num_key_value_heads?: number;
          head_dim?: number;
          hidden_size?: number;
        };
        const rawEos = cfg?.eos_token_id ?? (tok as unknown as { eos_token_id?: number }).eos_token_id;
        const eosIds = Array.isArray(rawEos) ? rawEos : rawEos != null ? [rawEos] : [];
        // The fixed instructions at the start of the system message are the same on every call, so
        // the model state after them is computed once. The cached span is the longest run of tokens
        // shared by the prompt and the fixed part alone (safe at the tokenizer boundary).
        const fixed = req.cache_prefix ?? (req.messages[0]?.role === "system" ? req.messages[0].content : "");
        let entry = usePrefixCache && fixed ? prefixCache.get(fixed) : undefined;
        if (usePrefixCache && fixed && !entry) {
          const alone = Array.from(tok.apply_chat_template([{ role: "system", content: fixed }], { add_generation_prompt: false, tokenize: true, return_tensor: false } as never) as unknown as number[], Number);
          let k = 0;
          while (k < alone.length && k < promptIds.length && alone[k] === promptIds[k]) k++;
          entry = { ids: promptIds.slice(0, Math.max(0, k - 1)) };
          prefixCache.set(fixed, entry);
          while (prefixCache.size > PREFIX_SLOTS) prefixCache.delete(prefixCache.keys().next().value!);
        } else if (entry) { prefixCache.delete(fixed); prefixCache.set(fixed, entry); } // LRU touch
        try {
          const genIds = await generateLowVram(session, promptIds, {
            prefix: entry, onPrefix: (st) => { if (entry) entry.state = st; },
            maxPromptTokens,
            maxNewTokens: req.max_tokens ?? 400,
            repetitionPenalty: 1.1,
            chunkSize: gpuChunkSize,
            eosIds,
            numHeads: cfg?.normalized_config?.num_heads ?? cfg?.num_attention_heads,
            numKeyValueHeads: cfg?.normalized_config?.num_kv_heads ?? cfg?.num_key_value_heads,
            headDim: cfg?.head_dim,
            hiddenSize: cfg?.hidden_size,
            createTensor: (type, data, dims) => (new Tensor(type as never, data as never, [...dims]) as unknown as { ort_tensor: ort.Tensor }).ort_tensor,
          });
          rawText = tok.decode(genIds, { skip_special_tokens: false });
        } catch {
          const retryInputs = tok.apply_chat_template(req.messages, {
            add_generation_prompt: true, return_dict: true, enable_thinking: !!req.enable_thinking,
          } as Parameters<PreTrainedTokenizer["apply_chat_template"]>[1]) as { input_ids: Tensor; attention_mask?: Tensor };
          const out = (await model.generate({
            ...retryInputs, max_new_tokens: req.max_tokens ?? 400, do_sample: false, repetition_penalty: 1.1,
          })) as Tensor;
          rawText = tok.batch_decode(out.slice(null, [n, out.dims[1]]), { skip_special_tokens: false })[0];
          out.dispose?.();
        }
      } else {
        const out = (await model.generate({
          ...inputs, max_new_tokens: req.max_tokens ?? 400, do_sample: false, repetition_penalty: 1.1,
        })) as Tensor;
        rawText = tok.batch_decode(out.slice(null, [n, out.dims[1]]), { skip_special_tokens: false })[0];
        out.dispose?.();
      }
      const content = rawText
        .replace(/<\|im_end\|>[\s\S]*$/, "").replace(/<\|endoftext\|>|<\|startoftext\|>/g, "");
      post({ id, ok: true, content, prompt_tokens: n, cached_tokens: [...prefixCache.values()].find((c) => c.state && promptIds.length > c.ids.length && c.ids.every((v, i) => promptIds[i] === v))?.ids.length ?? 0 });
    } else if (type === "cached") {
      post({ id, ok: true, cached: false });
    }
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};
