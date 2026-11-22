import { describe, expect, it } from "vitest";
import { heuristicEstimate, intendedTools, ruleParse, validateCalls } from "../src/ai/heuristics";
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
    expect(ruleParse("bump self-improvement goal to 4 hours", NOW, B)[0]).toMatchObject({ tool: "set_bucket_target", args: { bucket: "SELF", hours: 4 } });
    expect(ruleParse("set physics lab estimate to 2 hours", NOW, B)[0]).toMatchObject({ tool: "set_estimate", args: { minutes: 120 } });
    expect(ruleParse("I finished my calc homework", NOW, B)[0]).toMatchObject({ tool: "mark_done" });
  });
  it("recognizes the source date when moving an existing weekly block", () => {
    expect(ruleParse("move my AIME block from today to tomorrow evening", NOW, B)[0])
      .toMatchObject({ tool: "move_block", args: { target: "AIME", from_date: "2026-11-19", to_date: "2026-11-20", window: "evening" } });
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
  it("allows explicit routine edits and rejects invalid settings", () => {
    const calls = validateCalls([
      { tool: "set_schedule", args: { school_days: [1, 2, 3, 4, 5], school_start: "9:00", school_end: "16:00", after_school_min: 30 } },
      { tool: "set_schedule", args: { sleep_cutoff: "25:00" } },
      { tool: "set_schedule", args: { secret: true } },
      { tool: "move_block", args: { target: "AIME", from_date: "last week", to_date: "2026-11-20" } },
    ]);
    expect(calls).toEqual([{ tool: "set_schedule", args: { school_days: [1, 2, 3, 4, 5], school_start: "09:00", school_end: "16:00", after_school_min: 30 } }]);
    expect(intendedTools("change my school day to start at 9 and end at 4").has("set_schedule")).toBe(true);
    expect(intendedTools("what time does school start?").has("set_schedule")).toBe(false);
  });
  it("only enables saved milestones when the student asks to create them", () => {
    expect(intendedTools("Create a college roadmap and add its milestones to Tasks").has("add_task")).toBe(true);
    expect(intendedTools("What should I do to prepare for college?").has("add_task")).toBe(false);
    expect(validateCalls([
      { tool: "add_task", args: { title: "Research programs", course: "College Planning", due_date: "2027-01-15", estimated_minutes: 60 } },
      { tool: "add_task", args: { title: "Bad date", course: "College Planning", due_date: "next year" } },
    ])).toEqual([{ tool: "add_task", args: { title: "Research programs", course: "College Planning", due_date: "2027-01-15", estimated_minutes: 60 } }]);
  });
  it("rules path still covers the newer tools when no model is loaded", () => {
    expect(ruleParse("clear my whole Tuesday", NOW, B).map((c) => c.tool)).toContain("clear_day");
    const focus = ruleParse("this week is all about the AIME", NOW, B);
    expect(focus[0]?.tool).toBe("set_weekly_focus");
    expect(focus[0]?.args.focus).toBe("all about the AIME");
    expect(ruleParse("why is my plan like this", NOW, B).map((c) => c.tool)).toContain("explain_plan");
  });
  it("heuristic estimate counts problems", () => {
    const e = heuristicEstimate({ category: "homework", course: "AP Calculus BC", title: "HW 6.3", description: "6.3 #1-29 odd", points: 10 });
    expect(e.minutes).toBeGreaterThanOrEqual(40);
    expect(e.minutes).toBeLessThanOrEqual(65);
    expect(e.source).toBe("heuristic");
  });
});
