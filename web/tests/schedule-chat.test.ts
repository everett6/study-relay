import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store";
import { defaultState } from "../src/core/types";
import { Engine } from "../src/app/engine";
import { LLMClient } from "../src/ai/llmClient";
import { dayNum, validateCalls, validateSchedulePatch } from "../src/ai/heuristics";
import { plan } from "../src/core/schedule";
import { isoDow, parseLocal } from "../src/core/time";

const NOW = new Date(2026, 10, 19, 15, 0); // Thu

/** An LLM client whose model always answers with `reply` (JSON text). */
function withModel(reply: string) {
  const store = new Store(null, false);
  store.state = defaultState();
  const llm = new LLMClient();
  (llm as unknown as { engine: unknown }).engine = { chat: async () => reply };
  (llm as unknown as { status: unknown }).status = { state: "ready" };
  return { store, engine: new Engine(store, llm, () => NOW) };
}

describe("schedule changes from chat", () => {
  it("reads weekday names the way models write them", () => {
    expect([dayNum("Mon"), dayNum("wednesday"), dayNum("Thurs"), dayNum("tues"), dayNum(7), dayNum("3"), dayNum("someday")]).toEqual([1, 3, 4, 2, 7, 3, null]);
    const [c] = validateCalls([{ tool: "set_schedule", args: { school_end_by_day: { Mon: "14:45", Wed: "2:00", Thursday: "14:00" } } }]);
    expect(c.args.school_end_by_day).toEqual({ 1: "14:45", 3: "02:00", 4: "14:00" });
  });

  it("accepts per-day dismissal and quiet-time settings", () => {
    expect(validateSchedulePatch({ school_end_by_day: { 3: "14:00" } })).toEqual({ school_end_by_day: { 3: "14:00" } });
    expect(validateSchedulePatch({ quiet_weekend: ["09:00-12:00"] })).toEqual({ quiet_weekend: ["09:00-12:00"] });
    expect(validateSchedulePatch({ quiet_by_day: { 6: ["10:00-11:00"] } })).not.toBeNull();
  });

  it("'no studying on Sundays' given as quiet time becomes a rest day", () => {
    const [c] = validateCalls([{ tool: "set_schedule", args: { quiet_weekend: ["Sunday"] } }]);
    expect(c.args).toEqual({ rest_days: [7] });
  });

  it("dismissal times from chat change the week", async () => {
    const { store, engine } = withModel(JSON.stringify({ calls: [{ tool: "set_schedule", args: { school_end_by_day: { Mon: "14:45", Wed: "14:00" } } }], reply: "Updated." }));
    const out = await engine.run("school ends 2:45 monday and 2 on wednesday");
    expect(out.some((o) => o.tone === "ok")).toBe(true);
    expect(store.state.rules.school_end_by_day).toEqual({ 1: "14:45", 3: "14:00" });
  });

  it("a goal limited to weekends is only planned on weekends", async () => {
    const { store, engine } = withModel(JSON.stringify({ calls: [{ tool: "set_goal_days", args: { bucket: "AIME", days: ["Sat", "Sun"] } }], reply: "AIME is weekends only now." }));
    await engine.run("AIME on weekends only");
    expect(store.state.rules.goal_days).toEqual({ AIME: [6, 7] });
    const aime = store.state.blocks.filter((b) => b.bucket === "AIME" && b.status === "planned");
    expect(aime.length).toBeGreaterThan(0);
    expect(aime.every((b) => isoDow(parseLocal(b.start)) >= 6)).toBe(true);
  });

  it("never repeats a model's 'done' when nothing was applied", async () => {
    const { store, engine } = withModel(JSON.stringify({ calls: [{ tool: "set_schedule", args: { lunch: "13:00" } }], reply: "I've updated your schedule." }));
    const before = JSON.stringify(store.state.rules);
    const out = await engine.run("move lunch to 1");
    expect(JSON.stringify(store.state.rules)).toBe(before);
    expect(out).toHaveLength(1);
    expect(out[0].tone).toBe("warn");
    expect(out[0].text).toMatch(/Nothing was changed/);
  });

  it("asks again when the model thinks out loud instead of answering", async () => {
    const store = new Store(null, false);
    store.state = defaultState();
    const llm = new LLMClient();
    const replies = ["The user wants a day off. I should use set_schedule...", JSON.stringify({ calls: [{ tool: "set_schedule", args: { rest_days: [7] } }], reply: "Sundays are free now." })];
    (llm as unknown as { engine: unknown }).engine = { chat: async () => replies.shift() ?? "" };
    (llm as unknown as { status: unknown }).status = { state: "ready" };
    const engine = new Engine(store, llm, () => NOW);
    await engine.run("no studying on sundays");
    expect(store.state.rules.rest_days).toEqual([7]);
  });
});

describe("weekly goals in the plan", () => {
  it("keeps a day to a few subjects, one at a time", () => {
    const st = defaultState();
    const r = plan(st, NOW, { newId: (() => { let i = 0; return () => `b${i++}`; })() });
    for (const day of new Set(r.blocks.map((b) => b.date))) {
      const goals = r.blocks.filter((b) => b.date === day && b.kind === "bucket").sort((a, b) => a.start.localeCompare(b.start));
      expect(new Set(goals.map((b) => b.bucket)).size).toBeLessThanOrEqual(4);
      // a subject's blocks on a day are next to each other (no A-B-A pattern)
      const order = goals.map((b) => b.bucket).filter((k, i, a) => i === 0 || a[i - 1] !== k);
      expect(new Set(order).size).toBe(order.length);
    }
  });
});

describe("one-off days off", () => {
  it("'no school this week, skiing Thu-Sat' marks dates without changing the weekly routine", async () => {
    const store = new Store(null, false);
    store.state = defaultState();
    const llm = new LLMClient();
    const calls = [
      { tool: "days_off", args: { dates: ["2026-11-19", "2026-11-20"], away: false, title: null } },
      { tool: "days_off", args: { dates: ["2026-11-21"], away: true, title: "Skiing" } },
    ];
    (llm as unknown as { engine: unknown }).engine = { chat: async () => JSON.stringify({ calls, reply: "Done." }) };
    (llm as unknown as { status: unknown }).status = { state: "ready" };
    const engine = new Engine(store, llm, () => new Date(2026, 10, 19, 8, 0));
    await engine.run("no school today or tomorrow, skiing saturday");
    expect(store.state.rules.school_days).toEqual([1, 2, 3, 4, 5]);
    expect(store.state.rules.no_school_dates).toEqual(["2026-11-19", "2026-11-20", "2026-11-21"]);
    // a no-school weekday opens the morning for study; the ski day has none
    expect(store.state.blocks.some((b) => b.date === "2026-11-20" && b.start < "2026-11-20T12:00")).toBe(true);
    expect(store.state.blocks.some((b) => b.date === "2026-11-21" && b.status === "planned")).toBe(false);
  });
});

it("an echoed request from a weak model is reported, not shown as the answer", async () => {
  const { engine } = withModel('The student says: "no school this week"');
  const out = await engine.run("no school this week");
  expect(out).toHaveLength(1);
  expect(out[0].tone).toBe("warn");
  expect(out[0].text).toMatch(/unusable answer/);
});

it("never plans new work on top of a block that is under way", () => {
  const st = defaultState();
  st.blocks = [{ id: "run", date: "2026-11-21", start: "2026-11-21T09:00", end: "2026-11-21T09:45", kind: "bucket", bucket: "AIME",
    title: "AIME", load: 5, quiet: false, locked: false, status: "planned" }];
  const r = plan(st, new Date(2026, 10, 21, 9, 20), { newId: (() => { let i = 0; return () => `n${i++}`; })() });
  const others = r.blocks.filter((b) => b.id !== "run" && b.date === "2026-11-21");
  expect(r.blocks.some((b) => b.id === "run")).toBe(true);
  expect(others.every((b) => b.start >= "2026-11-21T09:45")).toBe(true);
});

it("a model's 'I moved it' is dropped when the move itself failed", async () => {
  const { engine } = withModel(JSON.stringify({ calls: [{ tool: "move_block", args: { target: "nonexistent thing", to_date: "2026-11-20", window: "evening" } }], reply: "I've moved it to tomorrow evening." }));
  const out = await engine.run("move the nonexistent thing to tomorrow evening");
  expect(out.every((o) => !o.text.includes("I've moved"))).toBe(true);
  expect(out[0].tone).toBe("warn");
});

import { resolveTarget } from "../src/ai/heuristics";
describe("which block a target means", () => {
  const buckets = defaultState().buckets;
  const tasks = [{ course: "English 1A", title: "Email English 1A teacher re: True Self & Music make-ups", category: "homework" as const, status: "open" as const },
    { course: "Biology", title: "Study Guide Questions", category: "homework" as const, status: "open" as const }];
  it("a goal word inside a long task title still means the task", () => {
    expect(resolveTarget("Email English 1A teacher re: True Self & Music make-ups", buckets, tasks).task?.course).toBe("English 1A");
    expect(resolveTarget("english teacher email", buckets, tasks).key).toBeNull();
  });
  it("a short goal name means the goal", () => {
    expect(resolveTarget("SELF", buckets, tasks).key).toBe("SELF");
    expect(resolveTarget("self-improvement block", buckets, tasks).key).toBe("SELF");
    expect(resolveTarget("AIME", buckets, tasks).key).toBe("AIME");
  });
});

it("moving a goal moves its whole back-to-back sitting", async () => {
  const { store, engine } = withModel(JSON.stringify({ calls: [{ tool: "move_block", args: { target: "AIME", from_date: "2026-11-21", to_date: "2026-11-21", window: "evening" } }], reply: "Moved." }));
  const mk = (id: string, s: string, e: string) => ({ id, date: "2026-11-21", start: `2026-11-21T${s}`, end: `2026-11-21T${e}`, kind: "bucket" as const,
    bucket: "AIME", title: "AIME (Competition Math)", load: 5, quiet: false, locked: true, status: "planned" as const });
  store.state.blocks = [mk("a1", "09:00", "09:45"), mk("a2", "09:55", "10:40")];
  await engine.run("move my AIME on saturday to the evening");
  const a = store.state.blocks.filter((b) => b.id === "a1" || b.id === "a2").sort((x, y) => x.start.localeCompare(y.start));
  expect(a).toHaveLength(2);
  expect(a.every((b) => b.start >= "2026-11-21T18:30" && b.locked)).toBe(true);
  expect((parseLocal(a[1].start).getTime() - parseLocal(a[0].end).getTime()) / 60000).toBe(10);
});

it("a goal with pinned time this week doesn't crowd out a goal with none", () => {
  const st = defaultState();
  st.rules.rest_days = [];
  const pin = (id: string, s: string, e: string) => ({ id, date: "2026-11-20", start: `2026-11-20T${s}`, end: `2026-11-20T${e}`, kind: "bucket" as const,
    bucket: "AIME", title: "AIME (Competition Math)", load: 5, quiet: false, locked: true, status: "planned" as const });
  st.blocks = [pin("p1", "16:15", "17:00"), pin("p2", "17:10", "17:55")];
  const r = plan(st, NOW, { newId: (() => { let i = 0; return () => `n${i++}`; })(), adjust: { dailyCap: 60 } });
  const thisWeek = r.blocks.filter((b) => b.kind === "bucket" && !b.locked && b.date <= "2026-11-22");
  expect(thisWeek.some((b) => b.bucket === "USAAIO")).toBe(true);
  expect(thisWeek.some((b) => b.bucket === "AIME")).toBe(false);
});

it("leaves a break before and after a pinned block", () => {
  const st = defaultState();
  st.blocks = [{ id: "pin", date: "2026-11-21", start: "2026-11-21T10:00", end: "2026-11-21T10:30", kind: "task", bucket: "SCHOOL",
    title: "English: email", load: 2, quiet: false, locked: true, status: "planned" }];
  const r = plan(st, NOW, { newId: (() => { let i = 0; return () => `n${i++}`; })() });
  const day = r.blocks.filter((b) => b.date === "2026-11-21" && b.id !== "pin");
  const gapOk = (b: { start: string; end: string }) => b.end <= "2026-11-21T09:50" || b.start >= "2026-11-21T10:40";
  expect(day.length).toBeGreaterThan(0);
  expect(day.every(gapOk)).toBe(true);
});
