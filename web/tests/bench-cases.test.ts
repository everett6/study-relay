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
