import { describe, expect, it } from "vitest";
import { intendedTools, mergeCalls, ruleParse } from "../src/ai/heuristics";
import { KEEP_CASES, NOW, buildPlannedState } from "../bench/cases";
import { defaultState } from "../src/core/types";

const B = defaultState().buckets;

describe("move vs keep", () => {
  it("splits 'keep X but move Y' into two calls", () => {
    const c = ruleParse("keep my AIME block tonight but move research to saturday afternoon", NOW, B);
    expect(c.map((x) => x.tool)).toEqual(["keep_block", "move_block"]);
  });
  it("'the physics lab' is the assignment, not the Physics goal", () => {
    const c = ruleParse("leave the physics lab where it is", NOW, B);
    expect(c[0]).toMatchObject({ tool: "keep_block", args: { target: "physics lab" } });
  });
  it("reads 'an hour and a half' as 90 minutes", () => {
    expect(ruleParse("the calc homework will take like an hour and a half", NOW, B)[0].args.minutes).toBe(90);
  });
  it("'don't move' is not a request to move", () => {
    expect(intendedTools("don't move the calc homework").has("move_block")).toBe(false);
    expect(intendedTools("don't move the calc homework").has("keep_block")).toBe(true);
  });
  it("drops model calls nobody asked for, and never moves what was kept", () => {
    const text = "don't move the calc homework, it has to get done today";
    const out = mergeCalls(
      [{ tool: "move_block", args: { target: "AP Calculus BC: HW 6.3", to_date: "2026-11-19", window: "morning" } },
        { tool: "ask_canvas", args: { what: "grades" } }],
      [{ tool: "keep_block", args: { target: "calc homework", date: null } }], text);
    expect(out).toEqual([{ tool: "keep_block", args: { target: "calc homework", date: null } }]);
  });
  it("rules alone pass the move/keep benchmark set", () => {
    const s = buildPlannedState();
    const passed = KEEP_CASES.filter((c) => c.check(ruleParse(c.text, NOW, s.buckets), s)).length;
    expect(passed).toBeGreaterThanOrEqual(3);
  });
});

import { matchTasks } from "../src/ai/heuristics";
describe("task matching", () => {
  it("short course names match by prefix", () => {
    const s = buildPlannedState();
    expect(matchTasks("calc homework", s.tasks)[0]?.id).toBe("canvas-9003");
    expect(matchTasks("chem quiz", s.tasks)[0]?.id).toBe("canvas-9007");
  });
});
