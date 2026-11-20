import { describe, expect, it } from "vitest";
import { heuristicEstimate, ruleParse, validateCalls } from "../src/ai/heuristics";
import { defaultState } from "../src/core/types";

const NOW = new Date(2026, 10, 19, 15, 0);
const B = defaultState().buckets;

describe("rule parser (LLM fallback)", () => {
  it("banquet tonight + pre-clear physics", () => {
    const c = ruleParse("I have a banquet at 7 tonight, preclear my physics homework before 6:30", NOW, B);
    expect(c[0]).toMatchObject({ tool: "add_event", args: { title: "Banquet", date: "2026-11-19", start: "19:00" } });
    expect(c[1]).toMatchObject({ tool: "preclear_task", args: { date: "2026-11-19", before: "18:30" } });
  });
  it("digs into Canvas classes", () => {
    expect(ruleParse("what's my grade in bio?", NOW, B)[0]).toMatchObject({ tool: "ask_canvas", args: { what: "grades", course: "bio" } });
    expect(ruleParse("any announcements for chemistry", NOW, B)[0]).toMatchObject({ tool: "ask_canvas", args: { what: "announcements", course: "chemistry" } });
    expect(ruleParse("show my missing assignments", NOW, B)[0]).toMatchObject({ tool: "ask_canvas", args: { what: "assignments", search: "missing" } });
  });
  it("timer, email drafts and mood", () => {
    expect(ruleParse("start a focus session for AIME", NOW, B)[0]).toMatchObject({ tool: "timer", args: { action: "start", target: "AIME" } });
    expect(ruleParse("pause the timer", NOW, B)[0]).toMatchObject({ tool: "timer", args: { action: "pause" } });
    const e = ruleParse("email my counselor about a 1:1 meeting this week", NOW, B)[0];
    expect(e.tool).toBe("draft_email");
    expect(e.args.to).toBe("counselor");
    expect(String(e.args.body)).toContain("1:1 meeting");
    expect(ruleParse("I'm so overwhelmed", NOW, B)[0]).toMatchObject({ tool: "check_in", args: { mood: 1 } });
    expect(ruleParse("i feel great", NOW, B)[0]).toMatchObject({ tool: "check_in", args: { mood: 5 } });
  });
  it("bucket target, estimate and done", () => {
    expect(ruleParse("bump AIME target to 8", NOW, B)[0]).toMatchObject({ tool: "set_bucket_target", args: { bucket: "AIME", hours: 8 } });
    expect(ruleParse("set physics lab estimate to 2 hours", NOW, B)[0]).toMatchObject({ tool: "set_estimate", args: { minutes: 120 } });
    expect(ruleParse("I finished my calc homework", NOW, B)[0]).toMatchObject({ tool: "mark_done" });
  });
  it("validateCalls drops malformed LLM output", () => {
    const ok = validateCalls({ calls: [
      { tool: "add_event", args: { title: "Game", date: "2026-11-20", start: "18:00" } },
      { tool: "add_event", args: { title: "Bad", date: "tomorrow", start: "6pm" } },
      { tool: "rm_rf", args: {} },
      { name: "draft_email", arguments: JSON.stringify({ to: "counselor", subject: "Hi", body: "Hello" }) },
      { tool: "check_in", args: { mood: 9 } },
    ] });
    expect(ok.map((c) => c.tool)).toEqual(["add_event", "draft_email"]);
  });
  it("heuristic estimate counts problems", () => {
    const e = heuristicEstimate({ category: "homework", course: "AP Calculus BC", title: "HW 6.3", description: "6.3 #1-29 odd", points: 10 });
    expect(e.minutes).toBeGreaterThanOrEqual(40);
    expect(e.minutes).toBeLessThanOrEqual(65);
    expect(e.source).toBe("heuristic");
  });
});
