import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store";
import { defaultState } from "../src/core/types";
import { Engine } from "../src/app/engine";
import { LLMClient } from "../src/ai/llmClient";
import { parseFlags } from "../src/core/canvas";
import { recordGrades, subjectFocus } from "../src/core/grades";

const NOW = new Date(2026, 10, 19, 15, 0);
const course = { id: 7, name: "P-ENGLISH 1A - E1100X - SMITH - Period 01" };

describe("zeros and missing work", () => {
  const raw = [
    { id: 1, name: "True Self", due_at: "2026-10-21T06:59:59Z", points_possible: 100, submission_types: ["online_upload"], submission: { workflow_state: "graded", score: 0 } },
    { id: 2, name: "TKAMB Study Guide", due_at: "2026-11-14T07:59:59Z", points_possible: 100, submission_types: ["online_upload"], submission: { workflow_state: "unsubmitted", score: null, submitted_at: null } },
    { id: 3, name: "Universal Truth Quiz", due_at: "2026-10-29T06:59:59Z", points_possible: 200, submission_types: ["online_quiz"], locked_for_user: true, submission: { workflow_state: "unsubmitted" } },
    { id: 4, name: "Paper essay", due_at: "2026-11-10T07:59:59Z", points_possible: 50, submission_types: ["on_paper"], submission: { workflow_state: "unsubmitted" } },
    { id: 5, name: "Excused", due_at: "2026-11-10T07:59:59Z", points_possible: 50, submission_types: ["online_upload"], submission: { workflow_state: "unsubmitted", excused: true } },
    { id: 6, name: "Fine", due_at: "2026-11-10T07:59:59Z", points_possible: 20, submission_types: ["online_upload"], submission: { workflow_state: "graded", score: 18, submitted_at: "x" } },
    { id: 7, name: "Extra credit", due_at: "2026-11-10T07:59:59Z", points_possible: 0, submission_types: ["online_upload"], submission: { workflow_state: "unsubmitted" } },
  ];

  it("finds never-turned-in work, skipping zeros (no redo assignments), paper, excused, graded and 0-point items", () => {
    const f = parseFlags(course, raw, NOW);
    expect(f.map((x) => [x.title, x.kind, x.can_submit])).toEqual([
      ["TKAMB Study Guide", "missing", true], ["Universal Truth Quiz", "missing", false]]);
    expect(f[0].course).toBe("English 1A");
  });

  it("plans make-up time for submittable missing work, flags the rest, and cleans up when fixed", () => {
    const store = new Store(null, false);
    store.state = defaultState();
    const engine = new Engine(store, new LLMClient(), () => NOW);
    const r = engine.updateFlags(parseFlags(course, raw, NOW), NOW);
    expect(r).toEqual({ added: 2, planned: 1 });
    const makeup = store.state.tasks.find((t) => t.id === "makeup-canvas-2")!;
    expect(makeup.title).toBe("Make up: TKAMB Study Guide");
    expect(store.state.blocks.some((b) => b.task_id === makeup.id)).toBe(true); // scheduled
    // English is now flagged in the grade view even at 95%
    store.update((st) => { st.grades = recordGrades(undefined, [{ course: "English 1A", score: 95, grade: "A" }], NOW); });
    expect(subjectFocus(store.state, NOW)[0]).toMatchObject({ level: "watch" });
    expect(subjectFocus(store.state, NOW)[0].reason).toContain("missing");
    // turned in on Canvas -> flag gone, make-up task closed
    engine.updateFlags(parseFlags(course, raw.filter((a) => a.id !== 2), NOW), NOW);
    expect(store.state.flags!.some((f) => f.id === "canvas-2")).toBe(false);
    expect(store.state.tasks.find((t) => t.id === "makeup-canvas-2")!.status).toBe("done");
    // dismiss removes its make-up task
    engine.dismissFlag("canvas-3");
    expect(store.state.flags!.find((f) => f.id === "canvas-3")!.status).toBe("dismissed");
    expect(engine.draftTeacherEmail("canvas-3")!.body).toContain("Universal Truth Quiz");
  });
});
