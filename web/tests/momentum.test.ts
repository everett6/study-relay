import { describe, expect, it } from "vitest";
import { ADJUST, checkIn, classifyMode, emptyMomentum, reconcile, recordSession } from "../src/ai/momentum";
import { plan } from "../src/core/schedule";
import { defaultState, type Block } from "../src/core/types";

const NOW = new Date(2026, 10, 19, 21, 0);

function blk(id: string, start: string, end: string, extra: Partial<Block> = {}): Block {
  return { id, date: start.slice(0, 10), start, end, kind: "bucket", bucket: "AIME", title: "AIME", load: 5, quiet: true, locked: false, status: "planned", ...extra };
}

describe("momentum baseline", () => {
  it("passed blocks without a session become misses and the plan re-places them", () => {
    const s = defaultState();
    for (const b of s.buckets) b.week = "2026-W47";
    s.blocks = [blk("a", "2026-11-19T16:15", "2026-11-19T17:00"), blk("b", "2026-11-19T17:10", "2026-11-19T17:55"),
      blk("c", "2026-11-19T18:05", "2026-11-19T18:50")];
    s.sessions = [{ id: "s", bucket: "AIME", planned_min: 45, actual_min: 44, energy: "high", outcome: "done", ended_at: new Date(2026, 10, 19, 17, 0).toISOString() }];
    const r = reconcile(s, NOW);
    expect(r.changed).toBe(3);
    expect(s.blocks.map((b) => b.status)).toEqual(["done", "missed", "missed"]);
    expect(s.momentum!.events.map((e) => e.kind)).toEqual(["hit", "miss", "miss"]);
    expect(reconcile(s, NOW).changed).toBe(0); // idempotent
    const p = plan(s, NOW, { adjust: ADJUST[s.momentum!.mode] });
    expect(p.blocks.filter((b) => b.status === "missed")).toHaveLength(2); // kept as history
    expect(p.blocks.filter((b) => b.kind === "bucket" && b.status === "planned" && b.start > "2026-11-19T21:00").length).toBeGreaterThan(0);
  });

  it("a run of misses shifts to stretched then overloaded; hits recover to thriving", () => {
    const s = defaultState();
    let t = new Date(2026, 10, 10, 17, 0);
    for (let i = 0; i < 12; i++) { recordSession(s, t, { blockId: `h${i}`, planned: 45, actual: 45, energy: "high" }); t = new Date(t.getTime() + 86400000 / 2); }
    expect(s.momentum!.mode).toBe("thriving");
    const add = (k: string) => { s.momentum!.events.push({ at: `2026-11-19T1${k.length}:00`, kind: "miss", key: k }); };
    add("m1"); add("m22");
    s.blocks = [];
    reconcile(s, NOW);
    expect(["stretched", "steady"]).toContain(s.momentum!.mode);
    add("m333"); add("m4444");
    reconcile(s, NOW);
    expect(s.momentum!.mode).toBe("overloaded");
    expect(ADJUST.overloaded.blockMin).toBeLessThan(ADJUST.steady.blockMin);
  });

  it("a rough check-in lightens the plan even before misses pile up", () => {
    const s = defaultState();
    s.momentum = emptyMomentum(NOW);
    checkIn(s, NOW, 2);
    expect(s.momentum!.mode).toBe("stretched");
    checkIn(s, NOW, 1);
    expect(s.momentum!.mode).toBe("overloaded");
  });

  it("stays steady with too little signal", () => {
    expect(classifyMode(0.3, 0.8, 0.5, null, 0, 2)).toBe("steady");
    expect(classifyMode(0.95, 0.8, 0.8, null, 0, 10)).toBe("thriving");
  });
});
