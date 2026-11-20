import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store";
import { defaultState } from "../src/core/types";
import { Engine } from "../src/app/engine";
import { LLMClient, gradeLine } from "../src/ai/llmClient";
import { mockESUHSD, parseGrades } from "../src/core/canvas";
import { applyEstimate, heuristicEstimate, ruleParse } from "../src/ai/heuristics";
import { recordGrades, subjectFocus, targetFrom } from "../src/core/grades";
import { addDays } from "../src/core/time";

const NOW = new Date(2026, 10, 19, 15, 0);
const mins = (b: { start: string; end: string }) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000;

function setup() {
  const store = new Store(null, false);
  store.state = defaultState();
  const engine = new Engine(store, new LLMClient(), () => NOW);
  store.update((st) => { st.tasks = mockESUHSD(NOW).map((t) => applyEstimate({ ...t }, heuristicEstimate(t))); });
  return { store, engine };
}

describe("grades and subject focus", () => {
  it("reads Canvas course scores", () => {
    const g = parseGrades([{ id: 1, name: "P-CHEMISTRY H - S7300XH - NGUYEN - Period 06", enrollments: [{ type: "student", computed_current_score: 84.2, computed_current_grade: "B" }] }]);
    expect(g).toEqual([{ course: "Chemistry H", score: 84.2, grade: "B" }]);
  });

  it("keeps one point per day and finds the two-week trend", () => {
    let g = recordGrades(undefined, [{ course: "Chemistry H", score: 90, grade: "A-" }], addDays(NOW, -14));
    g = recordGrades(g, [{ course: "Chemistry H", score: 86, grade: "B" }], addDays(NOW, -1));
    g = recordGrades(g, [{ course: "Chemistry H", score: 85, grade: "B" }], NOW);
    g = recordGrades(g, [{ course: "Chemistry H", score: 84, grade: "B" }], NOW);
    expect(g[0].history.map((h) => h.score)).toEqual([90, 86, 84]);
    const [f] = subjectFocus({ grades: g }, NOW);
    expect(f.trend).toBe(-6);
    expect(f.level).toBe("focus");
    expect(f.reviewMin).toBeGreaterThanOrEqual(30);
    expect(f.boost).toBeGreaterThan(1);
  });

  it("classes at their goal get nothing extra; ignored ones are skipped", () => {
    const g = recordGrades(undefined, [{ course: "Precalculus/AP", score: 95, grade: "A" }, { course: "PE", score: 100, grade: "A" }], NOW);
    g[1].ignore = true;
    const f = subjectFocus({ grades: g }, NOW);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ level: "ok", reviewMin: 0, boost: 1 });
  });

  it("a weak class gets weekly review blocks and more homework time in the plan", () => {
    const { store, engine } = setup();
    const chemTask = store.state.tasks.find((t) => t.course === "Chemistry H")!;
    const planned = () => store.state.blocks.filter((b) => b.task_id === chemTask.id && b.status === "planned").reduce((a, b) => a + mins(b), 0);
    const before = planned();
    expect(store.state.blocks.some((b) => b.title.startsWith("Review: "))).toBe(false);
    store.update((st) => { st.grades = recordGrades(undefined, [{ course: "Chemistry H", score: 90, grade: "A-" }], addDays(NOW, -14)); });
    engine.updateGrades([{ course: "Chemistry H", score: 82, grade: "B-" }, { course: "AP Calculus BC", score: 96, grade: "A" }], NOW);
    const review = store.state.blocks.filter((b) => b.title === "Review: Chemistry H");
    expect(review.length).toBeGreaterThan(0);
    expect(planned()).toBeGreaterThan(before);
    expect(store.state.blocks.some((b) => b.title === "Review: AP Calculus BC")).toBe(false);
    // lowering chem's goal cuts its review (it still slipped 8 points, so some stays); raising calc's adds review
    const reviewMins = () => subjectFocus(store.state, NOW).find((f) => f.course === "Chemistry H")!.reviewMin;
    const high = reviewMins();
    engine.setGradeTarget("chem", 80);
    expect(reviewMins()).toBeLessThan(high);
    expect(reviewMins()).toBeGreaterThan(0);
    expect(engine.setGradeTarget("calc", 99).ok).toBe(true);
    expect(store.state.blocks.some((b) => b.title === "Review: AP Calculus BC")).toBe(true);
    expect(gradeLine(store.state, NOW)).toContain("AP Calculus BC 96%");
  });

  it("understands grade goals in chat", () => {
    expect(ruleParse("I want an A in chem", NOW, defaultState().buckets)).toEqual([{ tool: "set_grade_target", args: { course: "chem", target: 93 } }]);
    expect(ruleParse("get my precalc grade to 95", NOW, defaultState().buckets)).toEqual([{ tool: "set_grade_target", args: { course: "precalc", target: 95 } }]);
    expect(targetFrom("a B+")).toBe(87);
    expect(targetFrom("lol")).toBeNull();
  });
});

import { validateCalls } from "../src/ai/heuristics";
describe("model output for grade goals", () => {
  it("accepts a letter grade from the model", () => {
    expect(validateCalls([{ tool: "set_grade_target", args: { course: "english", target: "A" } }])).toEqual([{ tool: "set_grade_target", args: { course: "english", target: 93 } }]);
  });
});
