import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store";
import { defaultState, SCHOOL } from "../src/core/types";
import { Engine, planKey } from "../src/app/engine";
import { LLMClient } from "../src/ai/llmClient";
import { mockESUHSD } from "../src/core/canvas";
import { heuristicEstimate, applyEstimate, ruleParse } from "../src/ai/heuristics";

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
