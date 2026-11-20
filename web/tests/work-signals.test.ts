import { describe, expect, it } from "vitest";
import { applyEstimate, heuristicEstimate, workSignals } from "../src/ai/heuristics";
import { parseAssignments } from "../src/core/canvas";
import type { Task } from "../src/core/types";

describe("Canvas workload signals", () => {
  it("counts problems, words, pages and report parts", () => {
    expect(workSignals({ title: "HW 6.3", description: "6.3 #1-29 odd" })).toContain("15 problems (odds/evens)");
    expect(workSignals({ title: "Essay Draft", description: "1000-1200 words, MLA format." })).toEqual(expect.arrayContaining(["1000-1200 words", "draft", "citations"]));
    expect(workSignals({ title: "Gatsby", description: "Read pp. 84-100 and annotate." })).toEqual(expect.arrayContaining(["17 pages", "annotations"]));
    expect(workSignals({ title: "Lab 4", description: "Full lab report with error analysis and uncertainty." })).toEqual(expect.arrayContaining(["lab report", "error analysis"]));
    expect(workSignals({ title: "Worksheet", description: "" })).toEqual([]);
  });

  it("keeps the Canvas submission type and explains the estimate", () => {
    const [t] = parseAssignments({ id: 1, name: "AP Physics" }, [{ id: 9, name: "Lab 2", description: "<p>Lab report with rubric</p>", due_at: "2026-11-25T23:59:00Z", points_possible: 40, submission_types: ["online_upload"] }], new Date("2026-11-19T12:00:00"));
    expect(t.description).toContain("Submit: upload");
    const e = heuristicEstimate(t);
    expect(e.why).toContain("lab report");
    expect(e.why).toContain("submit upload");
    applyEstimate(t as Task, e);
    expect(t.est_why).toBe(e.why);
  });
});
