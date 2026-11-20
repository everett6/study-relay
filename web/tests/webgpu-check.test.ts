import { afterEach, describe, expect, it, vi } from "vitest";
import { checkWebGPU } from "../src/ai/llmClient";

afterEach(() => vi.unstubAllGlobals());
const gpuWith = (answers: unknown[]) => { let i = 0; return { requestAdapter: vi.fn(async () => answers[Math.min(i++, answers.length - 1)]) }; };

describe("WebGPU check", () => {
  it("says the page must be https when it isn't", async () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("navigator", { gpu: gpuWith([{}]) });
    expect(await checkWebGPU()).toMatchObject({ ok: false, reason: "insecure" });
  });
  it("says the browser has WebGPU off", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {});
    expect(await checkWebGPU()).toMatchObject({ ok: false, reason: "no-api" });
  });
  it("retries when the GPU is briefly unavailable", async () => {
    vi.stubGlobal("isSecureContext", true);
    const gpu = gpuWith([null, {}]);
    vi.stubGlobal("navigator", { gpu });
    expect(await checkWebGPU()).toEqual({ ok: true });
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(2);
  });
  it("reports a missing adapter after all tries", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { gpu: gpuWith([null]) });
    expect(await checkWebGPU(2)).toMatchObject({ ok: false, reason: "no-adapter" });
  });
});
