import { describe, expect, it } from "vitest";
import { rankOpenRouterFreeModels } from "../src/ai/openRouterModels";

describe("OpenRouter free model ranking", () => {
  it("ranks planner-compatible models first, then uses reported benchmark and capabilities", () => {
    const ranked = rankOpenRouterFreeModels([
      { id: "unsupported/strong", name: "Strong but no tools", context_length: 128000,
        supported_parameters: [], intelligence_index: 60 },
      { id: "compatible/lower", name: "Compatible lower", context_length: 32768,
        supported_parameters: ["tools", "response_format"], intelligence_index: 31 },
      { id: "compatible/top", name: "Compatible top", context_length: 16384,
        supported_parameters: ["tools", "structured_outputs", "reasoning"], intelligence_index: 44 },
    ]);

    expect(ranked.map((model) => model.id)).toEqual([
      "compatible/top", "compatible/lower", "unsupported/strong",
    ]);
    expect(ranked[0].planner_compatible).toBe(true);
    expect(ranked[2].planner_compatible).toBe(false);
  });

  it("uses stable name ordering when capability and benchmark data are missing", () => {
    const ranked = rankOpenRouterFreeModels([
      { id: "z/model", name: "Zulu", context_length: 8192, supported_parameters: [] },
      { id: "a/model", name: "Alpha", context_length: 8192, supported_parameters: [] },
    ]);
    expect(ranked.map((model) => model.id)).toEqual(["a/model", "z/model"]);
  });
});
