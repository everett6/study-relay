import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store";
import { defaultState, SCHOOL } from "../src/core/types";
import { Engine, planKey } from "../src/app/engine";
import { LLMClient, longRangeMilestones, planLines, plannerSystem } from "../src/ai/llmClient";
import { mockESUHSD } from "../src/core/canvas";
import { heuristicEstimate, applyEstimate, ruleParse, validateCalls } from "../src/ai/heuristics";

const NOW = new Date(2026, 10, 19, 15, 0);

function setup() {
  const store = new Store(null, false);
  store.state = defaultState();
  const engine = new Engine(store, new LLMClient(), () => NOW);
  store.update((st) => {
    st.tasks = mockESUHSD(NOW).map((t) => applyEstimate({ ...t }, heuristicEstimate(t)));
  });
  return { store, engine };
}

describe("everything re-plans when one thing changes", () => {
  it("plans as soon as tasks arrive, with no explicit replan call", () => {
    const { store } = setup();
    expect(store.state.blocks.some((b) => b.task_id)).toBe(true);
    expect(store.state.meta.plan_key).toBe(planKey(store.state));
  });

  it("a raw edit (e.g. Canvas moving a due date) re-plans the rest", () => {
    const { store } = setup();
    const t = store.state.tasks[0];
    store.update((st) => { st.tasks.find((x) => x.id === t.id)!.status = "done"; });
    expect(store.state.blocks.filter((b) => b.task_id === t.id && b.status === "planned")).toHaveLength(0);
    expect(store.state.meta.plan_key).toBe(planKey(store.state));
  });

  it("an evening event pushes study blocks out of that time", () => {
    const { store } = setup();
    store.update((st) => { st.events.push({ id: "ev", title: "Banquet", kind: "event", start: "2026-11-19T19:00", end: "2026-11-19T21:00" }); });
    const clash = store.state.blocks.filter((b) => b.status === "planned" && b.start < "2026-11-19T21:00" && b.end > "2026-11-19T19:00");
    expect(clash).toHaveLength(0);
  });

  it("edits that don't touch planner inputs leave the plan alone", () => {
    const { store } = setup();
    const before = JSON.stringify(store.state.blocks);
    store.update((st) => { st.drafts.push({ id: "d", to: "x", subject: "s", body: "b", reason: "", status: "draft", created_at: "" } as never); });
    expect(JSON.stringify(store.state.blocks)).toBe(before);
  });

  it("changes synced from the relay are noticed too", () => {
    const { store, engine } = setup();
    store.state.buckets.find((b) => b.key !== SCHOOL)!.target_hours = 0; // as if Claude changed it over MCP
    expect(planKey(store.state)).not.toBe(store.state.meta.plan_key);
    engine.afterSync();
    expect(store.state.meta.plan_key).toBe(planKey(store.state));
  });

  it("AI routine edits change only requested rules and rebuild the plan", async () => {
    const { store, engine } = setup();
    const originalDinner = store.state.rules.dinner_start;
    const r = await engine.apply({ tool: "set_schedule", args: { school_start: "09:00", school_end: "16:00", after_school_min: 30 } }, "", NOW);
    expect(r.tone).toBe("ok");
    expect(store.state.rules).toMatchObject({ school_start: "09:00", school_end: "16:00", after_school_min: 30 });
    expect(store.state.rules.dinner_start).toBe(originalDinner);
    expect(store.state.meta.plan_key).toBe(planKey(store.state));
  });

  it("rejects an inconsistent school day without changing the saved schedule", async () => {
    const { store, engine } = setup();
    const before = { ...store.state.rules };
    const r = await engine.apply({ tool: "set_schedule", args: { school_start: "11:00", school_end: "10:00" } }, "", NOW);
    expect(r.tone).toBe("warn");
    expect(store.state.rules).toEqual(before);
  });

  it("ignores Piano changes while preserving existing Piano blocks", () => {
    const { store, engine } = setup();
    const before = planKey(store.state);
    const base = store.state.tasks[0];
    store.update((st) => {
      st.tasks.push({ ...base, id: "piano-task", course: "Music", title: "Piano lesson" });
      st.events.push({ id: "piano-event", title: "Piano recital", kind: "event", start: "2026-11-19T16:15", end: "2026-11-19T18:00" });
      st.blocks.push({ id: "piano-block", date: "2026-11-19", start: "2026-11-19T16:15", end: "2026-11-19T17:00",
        kind: "task", task_id: "piano-task", bucket: SCHOOL, title: "Music: Piano lesson", load: 3, quiet: false, locked: true, status: "planned" });
    });
    expect(planKey(store.state)).toBe(before);

    engine.replan();
    expect(store.state.blocks.filter((b) => b.task_id === "piano-task")).toHaveLength(1);
    expect(store.state.blocks.find((b) => b.id === "piano-block")).toMatchObject({ locked: true, status: "planned" });
  });

  it("shows a concise action trace after rule-based changes", async () => {
    const { engine } = setup();
    await engine.run("I have a banquet at 7 tonight");
    expect(engine.lastTrace).toContain("Decision source: Built-in rules");
    expect(engine.lastTrace).toContain("Action: Add calendar event");
    expect(engine.lastTrace.some((line) => line.startsWith("Outcome: Added Banquet"))).toBe(true);
  });

  it("does not add Piano events or change Piano grade targets through model tools", async () => {
    const { store, engine } = setup();
    const event = await engine.apply({ tool: "add_event", args: { title: "Piano recital", date: "2026-11-20", start: "18:00" } }, "", NOW);
    expect(event.text).toContain("Ignored the Piano event");
    expect(store.state.events.some((e) => e.title === "Piano recital")).toBe(false);

    const grade = await engine.apply({ tool: "set_grade_target", args: { course: "Piano", target: 95 } }, "", NOW);
    expect(grade.text).toContain("left it unchanged");
  });

  it("moves an existing calendar block in place with its original duration", async () => {
    const { store, engine } = setup();
    const source = { id: "move-aime", date: "2026-11-21", start: "2026-11-21T09:00", end: "2026-11-21T09:45",
      kind: "bucket" as const, bucket: "AIME", title: "AIME", load: 5, quiet: false, locked: false, status: "planned" as const };
    store.update((st) => { st.blocks.push(source); });
    const duration = Date.parse(source.end) - Date.parse(source.start);

    const result = await engine.apply({ tool: "move_block", args: {
      target: "AIME", from_date: source.date, to_date: "2026-11-24", window: "afternoon",
    } }, "", NOW);

    expect(result.tone, result.text).toBe("ok");
    const moved = store.state.blocks.find((b) => b.id === source.id)!;
    expect(moved).toMatchObject({ date: "2026-11-24", locked: true, status: "planned" });
    expect(Date.parse(moved.end) - Date.parse(moved.start)).toBe(duration);
  });

  it("does not claim to move a block when the target is not on the calendar", async () => {
    const { store, engine } = setup();
    const before = JSON.stringify(store.state.blocks);
    const result = await engine.apply({ tool: "move_block", args: { target: "ZZZ", to_date: "2026-11-24", window: "afternoon" } }, "", NOW);
    expect(result.tone).toBe("warn");
    expect(result.text).toContain("nothing was changed");
    expect(JSON.stringify(store.state.blocks)).toBe(before);
  });

  it("shows all seven Week-calendar days in the model's schedule context", () => {
    const state = defaultState();
    state.blocks.push({ id: "day-seven-goal", date: "2026-11-25", start: "2026-11-25T18:00", end: "2026-11-25T18:45",
      kind: "bucket", bucket: "AIME", title: "AIME", load: 5, quiet: false, locked: false, status: "planned" });
    const lines = planLines(state, NOW);
    expect(lines.split("\n")).toHaveLength(7);
    expect(lines).toContain("2026-11-25");
    expect(lines).toContain("18:00-18:45 AIME goal movable");
  });

  it("stores far-future college milestones and exposes them in later AI context", async () => {
    const { store, engine } = setup();
    const result = await engine.apply({ tool: "add_task", args: {
      title: "Research engineering programs", course: "College Planning", due_date: "2027-01-15",
      description: "Suggested checkpoint; verify official dates.", estimated_minutes: 60,
    } }, "", NOW);
    expect(result.tone).toBe("ok");

    const milestone = store.state.tasks.find((t) => t.title === "Research engineering programs")!;
    expect(milestone).toMatchObject({ source: "assistant", course: "College Planning", due_at: "2027-01-15T23:59" });
    expect(store.state.blocks.some((b) => b.task_id === milestone.id)).toBe(false);
    expect(longRangeMilestones(store.state, NOW)).toContain("2027-01-15 College Planning: Research engineering programs");
    expect(plannerSystem(store.state)).toContain("college-planning coach");
    expect(plannerSystem(store.state)).toContain("several months or years");
    expect(plannerSystem(store.state)).toContain("official deadlines");

    const duplicate = await engine.apply({ tool: "add_task", args: {
      title: "Research engineering programs", course: "College Planning", due_date: "2027-01-15",
    } }, "", NOW);
    expect(duplicate.tone).toBe("info");
    expect(store.state.tasks.filter((t) => t.title === milestone.title)).toHaveLength(1);
  });

  it("preserves a detailed model answer when no tool action is needed", async () => {
    const { engine } = setup();
    const answer = "College roadmap:\n1. Clarify your interests.\n2. Compare programs and costs.";
    engine.llm.command = async () => ({ calls: [], modelCalls: [], reply: answer, thinking: "", via: "llm" });
    const replies = await engine.run("How should I plan for college?");
    expect(engine.lastReply).toBe(answer);
    expect(engine.lastVia).toBe("llm");
    expect(replies[0].text).toBe(answer);
  });

  it("hydrates persistent conversation memory and saves new turns into synced state", async () => {
    const { store, engine } = setup();
    const previous = [
      { role: "user" as const, content: "I like engineering and math." },
      { role: "assistant" as const, content: "We can compare engineering programs." },
    ];
    store.state.ai_memory = previous;
    engine.llm.chatHistory = [{ role: "user", content: "stale tab history" }];
    let historySeen: typeof engine.llm.chatHistory = [];
    engine.llm.command = async () => {
      historySeen = [...engine.llm.chatHistory];
      engine.llm.chatHistory.push(
        { role: "user", content: "How do I compare costs?" },
        { role: "assistant", content: "Compare net price and aid." },
      );
      return { calls: [], modelCalls: [], reply: "Compare net price and aid.", thinking: "", via: "llm" };
    };

    await engine.run("How do I compare costs?");

    expect(historySeen).toEqual(previous);
    expect(store.state.ai_memory).toEqual([
      ...previous,
      { role: "user", content: "How do I compare costs?" },
      { role: "assistant", content: "Compare net price and aid." },
    ]);
    expect(engine.lastTrace).toContain("Persistent AI memory is saved locally and will sync when the relay is available.");
  });

  it("clears persistent and in-memory conversation context together", async () => {
    const { store, engine } = setup();
    store.state.ai_memory = [{ role: "user", content: "Remember my preferences." }];
    engine.llm.restoreHistory(store.state.ai_memory);

    await engine.clearChatMemory();

    expect(store.state.ai_memory).toEqual([]);
    expect(engine.llm.chatHistory).toEqual([]);
  });
});

describe("assign and reorder", () => {
  it("schedule_task puts all of a task's remaining work on the chosen day, and the rest re-plans", async () => {
    const { store, engine } = setup();
    const essay = store.state.tasks.find((t) => t.id === "canvas-9006")!;
    const need = (essay.human_minutes ?? essay.estimated_minutes);
    const r = await engine.apply({ tool: "schedule_task", args: { task_query: "essay draft", date: "2026-11-21", window: null } }, "", NOW);
    expect(r.tone).toBe("ok");
    const blocks = store.state.blocks.filter((b) => b.task_id === essay.id && b.status === "planned");
    expect(blocks.every((b) => b.date === "2026-11-21" && b.locked)).toBe(true);
    const mins = blocks.reduce((m, b) => m + (Date.parse(b.end) - Date.parse(b.start)) / 60000, 0);
    expect(mins).toBe(need);
    expect(store.state.meta.plan_key).toBe(planKey(store.state));
  });

  it("order_blocks swaps two blocks so the first one comes first", async () => {
    const { store, engine } = setup();
    const today = store.state.blocks.filter((b) => b.date === "2026-11-19" && b.status === "planned" && b.start > "2026-11-19T15:00")
      .sort((a, b) => a.start.localeCompare(b.start));
    expect(today.length).toBeGreaterThanOrEqual(2);
    const [early, late] = [today[0], today[today.length - 1]];
    const name = (b: typeof early) => b.kind === "bucket" ? b.bucket : b.title.split(": ").slice(1).join(": ");
    const r = await engine.apply({ tool: "order_blocks", args: { first: name(late), then: name(early), date: "2026-11-19" } }, "", NOW);
    expect(r.tone, r.text).toBe("ok");
    const a = store.state.blocks.find((b) => b.id === late.id)!, b = store.state.blocks.find((x) => x.id === early.id)!;
    expect(a.start < b.start).toBe(true);
    expect(a.locked && b.locked).toBe(true);
  });

  it("rules understand 'do X on Saturday' and 'X before Y tonight'", () => {
    const b = store0().state.buckets;
    expect(ruleParse("I'll do the essay draft on saturday", NOW, b)[0]).toMatchObject({ tool: "schedule_task", args: { date: "2026-11-21" } });
    expect(ruleParse("do chem before calc tonight", NOW, b)[0]).toMatchObject({ tool: "order_blocks", args: { first: "chem", then: "calc" } });
  });
});

function store0() { const s = new Store(null, false); s.state = defaultState(); return s; }

describe("undo AI changes", () => {
  it("restores the exact state from before an AI turn", async () => {
    const { store, engine } = setup();
    const before = JSON.stringify(store.state.events);
    const r = await engine.apply({ tool: "add_event", args: { title: "Banquet", date: "2026-11-20", start: "19:00", end: "21:00" } }, "", NOW);
    expect(r.tone).toBe("ok");
    expect(store.state.events.some((e) => e.title === "Banquet")).toBe(true);

    // Simulate the snapshot the run() path takes
    const snapshot = structuredClone(store.state);
    store.update((st) => { st.events.push({ id: "x", title: "Later", kind: "event", start: "2026-11-21T10:00", end: "2026-11-21T11:00" }); });
    expect(store.state.events.some((e) => e.title === "Later")).toBe(true);

    store.replace(snapshot);
    expect(store.state.events.some((e) => e.title === "Later")).toBe(false);
    expect(JSON.stringify(store.state.events)).toBe(JSON.stringify(JSON.parse(before).concat(
      [{ id: store.state.events.find((e) => e.title === "Banquet")!.id, title: "Banquet", kind: "event", start: "2026-11-20T19:00", end: "2026-11-20T21:00" }])));
  });

  it("reports nothing to undo when no AI turn has run", () => {
    const { engine } = setup();
    expect(engine.canUndoAI).toBe(false);
    expect(engine.undoLastAI()).toBeNull();
  });
});

describe("undo through the real run path", () => {
  it("undoes a full AI turn in one step", async () => {
    const { store, engine } = setup();
    const eventsBefore = store.state.events.length;
    engine.llm.command = async () => ({
      calls: [{ tool: "add_event", args: { title: "Banquet", date: "2026-11-20", start: "19:00", end: "21:00" } }],
      modelCalls: [], reply: "Added the banquet.", thinking: "", via: "llm",
    });
    await engine.run("banquet tomorrow at 7");
    expect(store.state.events.length).toBe(eventsBefore + 1);
    expect(engine.canUndoAI).toBe(true);

    const label = engine.undoLastAI();
    expect(label).toBe("Add calendar event");
    expect(store.state.events.length).toBe(eventsBefore);
    expect(engine.canUndoAI).toBe(false);
  });
});

describe("expanded tool set", () => {
  it("add_exam blocks the day and pulls that course's work ahead of it", async () => {
    const { store, engine } = setup();
    const before = store.state.tasks.filter((t) => t.status === "open").length;
    expect(before).toBeGreaterThan(0);

    const res = await engine.apply({ tool: "add_exam", args: { course: "CHEM", date: "2026-11-24", start: "10:00", weight: 40 } }, "", NOW);

    expect(res.tone).toBe("ok");
    expect(store.state.events.some((e) => e.kind === "event" && e.title.includes("CHEM") && e.start.startsWith("2026-11-24"))).toBe(true);
  });

  it("set_weekly_focus records the focus and keeps it across a replan", async () => {
    const { store, engine } = setup();
    const res = await engine.apply({ tool: "set_weekly_focus", args: { focus: "AIME prep" } }, "", NOW);
    expect(res.tone).toBe("ok");
    expect(store.state.rules.weekly_focus).toBe("AIME prep");
    expect(store.state.meta.plan_key).toBe(planKey(store.state));
  });

  it("clear_day empties the day and blackouts it", async () => {
    const { store, engine } = setup();
    const day = store.state.blocks.find((b) => b.status === "planned")!.date;
    const res = await engine.apply({ tool: "clear_day", args: { date: day } }, "", NOW);
    expect(res.tone).toBe("ok");
    expect(store.state.blocks.some((b) => b.date === day && b.status === "planned")).toBe(false);
    expect(store.state.events.some((e) => e.kind === "blackout" && e.start.startsWith(day))).toBe(true);
  });

  it("set_priority marks a task and re-plans", async () => {
    const { store, engine } = setup();
    const t = store.state.tasks.find((x) => x.status === "open")!;
    const res = await engine.apply({ tool: "set_priority", args: { task_query: t.title, priority: "high" } }, "", NOW);
    expect(res.tone).toBe("ok");
    expect(store.state.tasks.find((x) => x.id === t.id)!.priority).toBe("high");
  });

  it("explain_plan answers without changing the calendar", async () => {
    const { store, engine } = setup();
    const keyBefore = planKey(store.state);
    const res = await engine.apply({ tool: "explain_plan", args: { date: "2026-11-19" } }, "", NOW);
    expect(res.tone).toBe("info");
    expect(res.text.length).toBeGreaterThan(20);
    expect(planKey(store.state)).toBe(keyBefore);
  });

  it("validates the new tools and rejects bad args", () => {
    const good = [
      { tool: "add_exam", args: { course: "CHEM", date: "2026-11-24" } },
      { tool: "set_weekly_focus", args: { focus: "AIME" } },
      { tool: "clear_day", args: { date: "2026-11-24" } },
      { tool: "set_priority", args: { task_query: "essay", priority: "low" } },
      { tool: "explain_plan", args: {} },
    ];
    expect(validateCalls(good)).toHaveLength(good.length);

    const bad = [
      { tool: "add_exam", args: { course: "", date: "nope" } },
      { tool: "set_weekly_focus", args: { focus: "x" } },
      { tool: "clear_day", args: { date: "tomorrow" } },
      { tool: "set_priority", args: { task_query: "essay", priority: "urgent" } },
    ];
    expect(validateCalls(bad)).toHaveLength(0);
  });
});
