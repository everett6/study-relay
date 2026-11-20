import { describe, expect, it } from "vitest";
import type * as ort from "onnxruntime-web/webgpu";
import { f16ToF32, f32ToF16, generateLowVram, lowVramSessionOptions, mapStatePairs, sampleNextToken, type CachedState, type LowVramSession } from "../src/ai/ortLlm";

describe("custom low-VRAM ONNX WebGPU runner", () => {
  it("configures low-VRAM session options", () => {
    const opts = lowVramSessionOptions();
    expect(opts.enableMemPattern).toBe(false);
    expect(opts.enableCpuMemArena).toBe(false);
    expect(opts.preferredOutputLocation).toBe("gpu-buffer");
    expect(opts.freeDimensionOverrides).toEqual({ batch_size: 1 });
  });

  it("maps both attention KV and hybrid conv state pairs", () => {
    expect(mapStatePairs(
      ["input_ids", "past_key_values.0.key", "past_key_values.0.value", "past_conv.0"],
      ["logits", "present.0.key", "present.0.value", "present_conv.0"],
    )).toEqual([
      { past: "past_key_values.0.key", present: "present.0.key" },
      { past: "past_key_values.0.value", present: "present.0.value" },
      { past: "past_conv.0", present: "present_conv.0" },
    ]);
  });

  it("decodes float16 logits and applies repetition penalty on last token", () => {
    // 0x3c00 = 1.0, 0x4000 = 2.0, 0x4200 = 3.0 in IEEE 754 binary16
    expect(f16ToF32(0x3c00)).toBeCloseTo(1.0);
    expect(f16ToF32(0x4000)).toBeCloseTo(2.0);
    // 2 tokens x 3 vocab: last token has [1.0, 3.0, 2.0]
    const logits = new Uint16Array([0x4200, 0x3c00, 0x3c00, 0x3c00, 0x4200, 0x4000]);
    expect(sampleNextToken(logits, "float16", 3, new Set(), 1.0)).toBe(1);
    // Penalizing token 1 (3.0 / 2.0 = 1.5 < 2.0) picks token 2
    expect(sampleNextToken(logits, "float16", 3, new Set([1]), 2.0)).toBe(2);
  });

  it("runs chunked prefill and disposes all intermediate and final GPU tensors", async () => {
    const tracked: { disposed: boolean }[] = [];
    const makeOutTensor = (data: Float32Array, dims: number[]) => {
      const rec = { disposed: false };
      tracked.push(rec);
      return {
        dims,
        type: "float32",
        getData: async () => data,
        dispose: () => { rec.disposed = true; },
      } as unknown as ort.Tensor;
    };

    const chunkLengths: number[] = [];
    const seq = [10, 11, 2]; // emits 10, 11, then EOS (2)
    let callIdx = 0;

    const session: LowVramSession = {
      inputNames: ["input_ids", "attention_mask", "position_ids", "num_logits_to_keep", "past_key_values.0.key", "past_conv.0"],
      outputNames: ["logits", "present.0.key", "present_conv.0"],
      inputMetadata: [
        { name: "num_logits_to_keep", shape: [], type: "int64" },
        { name: "past_key_values.0.key", shape: ["batch_size", 2, "past_seq", 4], type: "float32" },
        { name: "past_conv.0", shape: ["batch_size", 4, 3], type: "float32" },
      ],
      async run(feeds) {
        chunkLengths.push(feeds.input_ids.dims[1]);
        const target = seq[Math.max(0, callIdx - 2)] ?? 10; // prefill has 3 chunks (2,2,1), 3rd chunk emits 10
        callIdx++;
        const logits = new Float32Array(16);
        logits[target] = 5.0;
        return {
          logits: makeOutTensor(logits, [1, 1, 16]),
          "present.0.key": makeOutTensor(new Float32Array(8), [1, 2, 1, 4]),
          "present_conv.0": makeOutTensor(new Float32Array(12), [1, 4, 3]),
        };
      },
    };

    const out = await generateLowVram(session, [1, 3, 4, 5, 6], { chunkSize: 2, eosIds: [2], maxNewTokens: 10 });
    expect(chunkLengths).toEqual([2, 2, 1, 1, 1]);
    expect(out).toEqual([10, 11]);
    expect(tracked.every((t) => t.disposed)).toBe(true);
  });

  it("prefix KV cache: same tokens out, fewer tokens prefilled", async () => {
    // fake model whose state is the running sum of every token seen; next token = (sum + last) % 13 + 3
    let fed = 0;
    const tensor = (data: Float32Array, dims: number[]) =>
      ({ dims, type: "float32", data, getData: async () => data, dispose: () => {} }) as unknown as ort.Tensor;
    const session: LowVramSession = {
      inputNames: ["input_ids", "past_key_values.0.key"],
      outputNames: ["logits", "present.0.key"],
      inputMetadata: [{ name: "past_key_values.0.key", shape: ["batch_size", 1], type: "float32" }],
      async run(feeds) {
        const ids = Array.from(feeds.input_ids.data as BigInt64Array, Number);
        fed += ids.length;
        const past = feeds["past_key_values.0.key"].data as Float32Array;
        const sum = (past[0] ?? 0) + ids.reduce((a, b) => a + b, 0);
        const logits = new Float32Array(16);
        logits[(sum + ids[ids.length - 1]) % 13 + 3] = 5;
        return { logits: tensor(logits, [1, 1, 16]), "present.0.key": tensor(Float32Array.from([sum]), [1, 1]) };
      },
    };
    const sys = [1, 4, 1, 5, 9, 2, 6, 5];
    const prompt = [...sys, 3, 5, 8];
    const opts = { chunkSize: 2, maxNewTokens: 4, repetitionPenalty: 1 };

    fed = 0;
    const plain = await generateLowVram(session, prompt, opts);
    const plainFed = fed;

    const entry: { ids: number[]; state?: CachedState } = { ids: sys };
    fed = 0;
    const first = await generateLowVram(session, prompt, { ...opts, prefix: entry, onPrefix: (st) => { entry.state = st; } });
    expect(first).toEqual(plain);
    expect(entry.state?.len).toBe(sys.length);

    fed = 0;
    const reused = await generateLowVram(session, prompt, { ...opts, prefix: entry });
    expect(reused).toEqual(plain);
    expect(fed).toBe(plainFed - sys.length);
    // f32 -> f16 compression cuts float32 prefix KV cache RAM in half (2 bytes per element)
    expect(entry.state?.bytes).toBe(2);
    expect(f16ToF32(f32ToF16(12.5))).toBeCloseTo(12.5, 2);

    // a prompt that doesn't start with the cached prefix ignores the cache
    fed = 0;
    await generateLowVram(session, [7, ...prompt], { ...opts, prefix: entry });
    expect(fed).toBe(plainFed + 1);
  });
});
