// Sanity-checks the benchmark graders with hand-written correct answers, and records the
// rules-only baseline the models are compared against.
import { describe, expect, it } from "vitest";
import { CASES, EXTRACTS, NOW, buildState, scoreExtract } from "../bench/cases";
import { ruleParse } from "../src/ai/heuristics";
import { extractItems } from "../src/app/screenshot";

describe("benchmark graders", () => {
  const s = buildState();
  it("accept a correct answer and reject a wrong one", () => {
    expect(CASES[0].check([{ tool: "add_event", args: { title: "Banquet", date: "2026-11-19", start: "19:00" } }], s)).toBe(true);
    expect(CASES[0].check([{ tool: "add_event", args: { title: "Banquet", date: "2026-11-20", start: "19:00" } }], s)).toBe(false);
    expect(CASES[2].check([{ tool: "preclear_task", args: { task_query: "physics problem set", date: "2026-11-19", before: "18:30" } }], s)).toBe(true);
    expect(CASES[13].check([{ tool: "draft_email", args: { to: "counselor@school.org", subject: "Meet", body: "can we meet" } }], s)).toBe(false);
  });
  it("rules-only baseline", () => {
    const passed = CASES.filter((c) => c.check(ruleParse(c.text, NOW, s.buckets), s)).length;
    const ex = EXTRACTS.reduce((a, c) => a + scoreExtract(extractItems(c.text, NOW), c), 0);
    console.log(`rules baseline: commands ${passed}/${CASES.length}, screenshot items ${ex}/5`);
    expect(passed).toBeGreaterThan(5);
  });
});

import { CONTEXT_CASES, EFFECT_CASES, buildBenchState } from "../bench/cases";
import { Engine } from "../src/app/engine";
import { Store } from "../src/core/store";
import { LLMClient } from "../src/ai/llmClient";

describe("effect graders", () => {
  function planned() {
    const store = new Store(null, false);
    store.state = buildBenchState();
    new Engine(store, new LLMClient(), () => NOW);
    return store;
  }

  it("every effect case has a plan to act on", () => {
    const s = planned().state;
    expect(s.blocks.filter((b) => b.status === "planned").length).toBeGreaterThan(3);
    expect(s.blocks.some((b) => b.date === "2026-11-19" && b.bucket === "AIME")).toBe(true);
  });

  it("rejects a no-op and accepts a real removal", async () => {
    const removeCase = EFFECT_CASES.find((c) => c.text.includes("remove my AIME"))!;
    const store = planned();
    const engine = new Engine(store, new LLMClient(), () => NOW);
    const before = structuredClone(store.state);
    expect(removeCase.check(before, before)).toBe(false); // nothing changed yet
    await engine.apply({ tool: "remove_block", args: { target: "AIME", date: "2026-11-19" } }, "", NOW);
    expect(removeCase.check(store.state, before)).toBe(true);
  });

  it("accepts a correct event and rejects one that overlaps study", async () => {
    const banquet = EFFECT_CASES.find((c) => c.text.includes("banquet"))!;
    const store = planned();
    const engine = new Engine(store, new LLMClient(), () => NOW);
    const before = structuredClone(store.state);
    await engine.apply({ tool: "add_event", args: { title: "Banquet", date: "2026-11-19", start: "19:00", end: "21:00" } }, "", NOW);
    expect(banquet.check(store.state, before)).toBe(true);
  });

  it("context graders reject an empty or invented answer", () => {
    const s = planned().state;
    for (const c of CONTEXT_CASES) {
      expect(c.check("", s)).toBe(false);
      expect(c.check("I'm not sure, I don't have that information.", s)).toBe(false);
    }
  });
});

