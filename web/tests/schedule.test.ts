import { describe, expect, it } from "vitest";
import { plan, validateBlock } from "../src/core/schedule";
import { defaultState, type State, type Task } from "../src/core/types";
import { hm, parseLocal } from "../src/core/time";

const NOW = new Date(2026, 10, 19, 15, 0); // Thu Nov 19 2026, 3:00 PM
let n = 0;
const id = () => `b${++n}`;

function task(p: Partial<Task>): Task {
  return { id: p.id ?? `t${++n}`, source: "manual", course: "AP Physics C", title: "PS7", category: "homework", task_type: "HW",
    due_at: "2026-11-20T23:59", cognitive_load: 4, llm_minutes: 90, estimated_minutes: 90, human_minutes: null, confidence: 0.6,
    recommended_45m_blocks: [45, 45], est_source: "heuristic", logged_minutes: 0, status: "open", ...p };
}

function state(tasks: Task[] = []): State {
  const s = defaultState();
  s.tasks = tasks;
  for (const b of s.buckets) b.week = "2026-W47";
  return s;
}

const mm = (iso: string) => hm(iso.slice(11));

describe("planner buffer rules", () => {
  it("never schedules in school, the after-school break, dinner or after the sleep cutoff", () => {
    const s = state([task({}), task({ id: "x", title: "Unit test", category: "test", task_type: "Exam", due_at: "2026-11-24T08:30", estimated_minutes: 180 })]);
    const r = plan(s, NOW, { newId: id });
    expect(r.blocks.length).toBeGreaterThan(5);
    for (const b of r.blocks) {
      const s0 = mm(b.start), e0 = mm(b.end);
      const dow = parseLocal(b.start).getDay();
      if (dow >= 1 && dow <= 5) {
        expect(s0 >= hm("16:15") || e0 <= hm("08:30")).toBe(true); // school 8:30-3:30 + 45 min break
      } else expect(s0).toBeGreaterThanOrEqual(hm("09:00"));
      expect(e0 <= hm("19:00") || s0 >= hm("20:30")).toBe(true); // dinner 7:00-8:30
      expect(e0).toBeLessThanOrEqual(hm("22:30"));
      expect(e0).toBeGreaterThan(s0);
    }
  });

  it("puts work due tomorrow before the deadline and covers the full estimate", () => {
    const s = state([task({ id: "ps7" })]);
    const r = plan(s, NOW, { newId: id });
    const mine = r.blocks.filter((b) => b.task_id === "ps7");
    expect(mine.reduce((a, b) => a + (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000, 0)).toBe(90);
    for (const b of mine) expect(parseLocal(b.end) <= parseLocal("2026-11-20T23:59")).toBe(true);
    expect(r.atRisk).toEqual([]);
  });

  it("momentum adjustments shorten blocks and lighten Tier 2 goals, but not school work", () => {
    const s = state([task({ id: "ps7" })]);
    const normal = plan(s, NOW, { newId: id });
    const easy = plan(s, NOW, { newId: id, adjust: { blockMin: 25, breakMin: 15, tier2Factor: 0.6, dailyCap: 90 } });
    const len = (bs: typeof normal.blocks) => Math.max(...bs.map((b) => (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000));
    expect(len(easy.blocks)).toBeLessThanOrEqual(35);
    expect(len(easy.blocks)).toBeLessThan(len(normal.blocks));
    const t2 = (bs: typeof normal.blocks) => bs.filter((b) => b.kind === "bucket").length;
    expect(t2(easy.blocks)).toBeLessThan(t2(normal.blocks) * 1.2 + 1);
    const sum = (bs: typeof normal.blocks, k: string) => bs.filter((b) => b.task_id === k).reduce((a, b) => a + (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000, 0);
    expect(sum(easy.blocks, "ps7")).toBe(90);
    const goalMin = (bs: typeof normal.blocks) => bs.filter((b) => b.kind === "bucket").reduce((a, b) => a + (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000, 0);
    expect(goalMin(easy.blocks)).toBeLessThan(goalMin(normal.blocks));
  });

  it("limits weekly-goal blocks to the daily budget left after schoolwork", () => {
    const s = state([task({ id: "urgent", estimated_minutes: 90, due_at: "2026-11-20T23:59" })]);
    for (const b of s.buckets) if (b.key !== "SCHOOL") b.target_hours = 20;
    const r = plan(s, NOW, { newId: id, adjust: { blockMin: 25, breakMin: 15, dailyCap: 90, tier2Factor: 1 } });
    const studyByDay = new Map<string, number>();
    for (const b of r.blocks.filter((x) => x.status === "planned")) {
      const duration = (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000;
      studyByDay.set(b.date, (studyByDay.get(b.date) ?? 0) + duration);
    }
    expect([...studyByDay.values()].every((minutes) => minutes <= 90)).toBe(true);
    expect(Object.values(r.shortfall).some((minutes) => minutes > 0)).toBe(true);
    expect(new Set(r.blocks.filter((b) => b.date === "2026-11-21" && b.kind === "bucket").map((b) => b.bucket)).size).toBeGreaterThan(1);
  });

  it("counts completed and pinned study blocks toward the daily budget", () => {
    const s = state();
    for (const b of s.buckets) if (b.key !== "SCHOOL") b.target_hours = 20;
    s.blocks = [
      { id: "done", date: "2026-11-21", start: "2026-11-21T09:00", end: "2026-11-21T10:00",
        kind: "bucket", bucket: "AIME", title: "AIME", load: 5, quiet: false, locked: false, status: "done" },
      { id: "kept", date: "2026-11-21", start: "2026-11-21T10:30", end: "2026-11-21T11:00",
        kind: "bucket", bucket: "USAAIO", title: "USAAIO", load: 5, quiet: false, locked: true, status: "planned" },
    ];
    const r = plan(s, new Date(2026, 10, 21, 10, 0), { newId: id, adjust: { blockMin: 25, breakMin: 15, dailyCap: 90, tier2Factor: 1 } });
    const satMinutes = r.blocks.filter((b) => b.date === "2026-11-21" && b.status !== "missed")
      .reduce((sum, b) => sum + (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000, 0);
    expect(satMinutes).toBe(90);
  });

  it("an evening event pre-clear is honored", () => {
    const s = state([task({ id: "calc", course: "AP Calc", estimated_minutes: 45, due_at: "2026-11-20T08:30", preclear_by: "2026-11-19T18:30" })]);
    s.events.push({ id: "e", title: "Banquet", kind: "event", start: "2026-11-19T19:00", end: "2026-11-19T21:30" });
    const r = plan(s, NOW, { newId: id });
    const b = r.blocks.filter((x) => x.task_id === "calc");
    expect(b.length).toBeGreaterThan(0);
    for (const x of b) expect(x.end <= "2026-11-19T18:30").toBe(true);
    expect(r.blocks.some((x) => x.start < "2026-11-19T21:30" && x.end > "2026-11-19T19:00")).toBe(false);
  });

  it("assignments due after the planning horizon are deferred, not flagged at risk", () => {
    const s = state([task({ id: "far", title: "Essay", category: "project", task_type: "Project", due_at: "2026-12-01T23:59", estimated_minutes: 200 })]);
    const r = plan(s, NOW, { newId: id });
    expect(r.atRisk).toEqual([]);
    const s2 = state([task({ id: "near", estimated_minutes: 2000, due_at: "2026-11-20T23:59" })]);
    expect(plan(s2, NOW, { newId: id }).atRisk.map((x) => x.task_id)).toEqual(["near"]); // real overload still shows
  });

  it("validateBlock rejects protected time", () => {
    const r = defaultState().rules;
    expect(validateBlock(r, [], "2026-11-19T10:00", "2026-11-19T10:45")).toMatch(/outside|school/);
    expect(validateBlock(r, [], "2026-11-19T19:15", "2026-11-19T20:00")).toMatch(/Dinner|dinner/i);
    expect(validateBlock(r, [], "2026-11-19T22:00", "2026-11-19T23:00")).toMatch(/outside|sleep/);
    expect(validateBlock(r, [], "2026-11-19T16:30", "2026-11-19T17:15")).toBeNull();
  });
});
