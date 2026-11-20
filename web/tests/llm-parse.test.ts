import { describe, expect, it } from "vitest";
import { parseJSONReply, weekLine } from "../src/ai/llmClient";

describe("model reply parsing", () => {
  it("skips reasoning and code fences", () => {
    expect(parseJSONReply('<think>maybe {"a":1}?</think>\n```json\n{"calls":[],"reply":"ok"}\n```')).toEqual({ calls: [], reply: "ok" });
    expect(parseJSONReply('<think></think>{"minutes":45}')).toEqual({ minutes: 45 });
    expect(parseJSONReply('{"x":2}')).toEqual({ x: 2 });
  });
  it("returns null for unfinished reasoning or junk", () => {
    expect(parseJSONReply('<think>still going {"a":')).toBeNull();
    expect(parseJSONReply("no json here")).toBeNull();
  });
  it("lists the coming week with weekday names", () => {
    const w = weekLine(new Date(2026, 10, 19, 15, 0));
    expect(w.startsWith("Thu 2026-11-19 (today), Fri 2026-11-20 (tomorrow), Sat 2026-11-21")).toBe(true);
  });
});

import { validateCalls } from "../src/ai/heuristics";
import { parseJSONReply as parse2 } from "../src/ai/llmClient";
describe("format adapters", () => {
  it("reads LFM3 XML tool calls", () => {
    const j = parse2("<tool_call>\n<function=add_event>\n<parameter=title>\nBanquet\n</parameter>\n<parameter=date>\n2026-11-19\n</parameter>\n<parameter=start>\n19:00\n</parameter>\n</function>\n</tool_call>\nHave fun!") as { calls: unknown; reply: string };
    expect(validateCalls(j.calls)).toEqual([{ tool: "add_event", args: { title: "Banquet", date: "2026-11-19", start: "19:00" } }]);
    expect(j.reply).toBe("Have fun!");
  });
  it("accepts flat-argument JSON calls", () => {
    expect(validateCalls([{ tool: "cancel_study", date: "2026-11-19", after: "20:00" }]))
      .toEqual([{ tool: "cancel_study", args: { date: "2026-11-19", after: "20:00" } }]);
  });
  it("picks last fenced JSON block and top-level arrays", () => {
    const selfCorrected = '{"calls":[bad} Oops!\n```json\n{"calls":[{"tool":"draft_email","args":{"to":"counselor","subject":"Hi","body":"Meet?"}}],"reply":"Done"}\n```';
    expect(parse2(selfCorrected)).toEqual({
      calls: [{ tool: "draft_email", args: { to: "counselor", subject: "Hi", body: "Meet?" } }],
      reply: "Done",
    });
    expect(parse2('[{"title":"CAD files","due":"2026-11-22T21:00:00","kind":"task"}]')).toEqual([
      { title: "CAD files", due: "2026-11-22T21:00:00", kind: "task" },
    ]);
  });
  it("normalizes ask_canvas aliases and HH:MM times", () => {
    expect(validateCalls([
      { tool: "ask_canvas", args: { ask: "grades", course: "chem" } },
      { tool: "ask_canvas", args: { ask_type: "announcements" } },
      { tool: "add_event", args: { title: "Club", date: "2026-11-20", start: "9:00", end: "10:30:00" } },
    ])).toEqual([
      { tool: "ask_canvas", args: { ask: "grades", what: "grades", course: "chem" } },
      { tool: "ask_canvas", args: { ask_type: "announcements", what: "announcements" } },
      { tool: "add_event", args: { title: "Club", date: "2026-11-20", start: "09:00", end: "10:30" } },
    ]);
  });
});
