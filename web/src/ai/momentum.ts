// Adaptive baseline built from hits and misses.
//
// Every planned block either gets done (hit), half done (partial) or silently passes (miss).
// Two moving averages of the hit rate are kept: a fast one (last few blocks) and a slow one
// (the personal baseline). Energy ratings from Study Mode and the optional one-tap mood
// check-in are blended in. The result is a workload mode that reshapes the plan:
// shorter blocks, longer breaks and lighter Tier 2 goals when things slip, a little more
// room when things go well. It is a workload signal, not a diagnosis, and it never moves
// school deadlines or the sleep cutoff.

import type { Block, Mode, Momentum, MomentumEvent, Session, State } from "../core/types";
import type { Adjust } from "../core/schedule";
import { fmtLocal, parseLocal } from "../core/time";

const FAST = 0.25, SLOW = 0.08;
const ENERGY: Record<string, number> = { low: 0, med: 0.5, high: 1 };
const GRACE_MIN = 20; // a block counts as missed this long after it ends

export function emptyMomentum(now: Date): Momentum {
  return { events: [], fast: 0.8, slow: 0.8, energy: 0.6, mood: null, mode: "steady", since: fmtLocal(now) };
}

const value = (e: MomentumEvent): number | null =>
  e.kind === "hit" ? 1 : e.kind === "partial" ? 0.5 : e.kind === "miss" ? 0 : null;

/** Recompute the averages and the mode from the event log (pure, deterministic). */
export function recompute(m: Momentum, now: Date): Momentum {
  let fast = 0.8, slow = 0.8, energy = 0.6;
  let mood: number | null = null, moodAt = 0;
  const evs = [...m.events].sort((a, b) => a.at.localeCompare(b.at));
  for (const e of evs) {
    const v = value(e);
    if (v !== null) { fast += FAST * (v - fast); slow += SLOW * (v - slow); }
    if (e.energy) energy += 0.3 * (ENERGY[e.energy] - energy);
    if (e.mood) { mood = (e.mood - 1) / 4; moodAt = parseLocal(e.at).getTime(); }
  }
  if (mood !== null && now.getTime() - moodAt > 3 * 86400000) mood = null; // check-ins fade after 3 days
  const scored = evs.filter((e) => value(e) !== null);
  let streak = 0;
  for (let i = scored.length - 1; i >= 0 && scored[i].kind === "miss"; i--) streak++;
  const mode = classifyMode(fast, slow, energy, mood, streak, scored.length);
  return { ...m, events: evs.slice(-120), fast: r3(fast), slow: r3(slow), energy: r3(energy), mood: mood === null ? null : r3(mood),
    mode, since: mode === m.mode ? m.since : fmtLocal(now) };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function classifyMode(fast: number, slow: number, energy: number, mood: number | null, missStreak: number, n: number): Mode {
  if (n < 3 && mood === null) return "steady"; // not enough signal yet
  const wellbeing = mood ?? energy;
  const score = 0.6 * fast + 0.25 * energy + 0.15 * wellbeing;
  if (missStreak >= 3 || fast < 0.45 || score < 0.45 || (mood !== null && mood <= 0.15)) return "overloaded";
  if (fast < slow - 0.12 || score < 0.62 || energy < 0.3 || (mood !== null && mood <= 0.35)) return "stretched";
  if (fast >= 0.88 && slow >= 0.72 && energy >= 0.55 && (mood === null || mood >= 0.5)) return "thriving";
  return "steady";
}

export const ADJUST: Record<Mode, Required<Adjust>> = {
  thriving: { blockMin: 50, breakMin: 10, tier2Factor: 1.0, dailyCap: 180 },
  steady: { blockMin: 45, breakMin: 10, tier2Factor: 1.0, dailyCap: 150 },
  stretched: { blockMin: 35, breakMin: 15, tier2Factor: 0.85, dailyCap: 120 },
  overloaded: { blockMin: 25, breakMin: 15, tier2Factor: 0.6, dailyCap: 90 },
};

export const MODE_COPY: Record<Mode, { emoji: string; title: string; line: string }> = {
  thriving: { emoji: "🚀", title: "On a roll", line: "You're hitting almost every block, so blocks get a bit longer." },
  steady: { emoji: "🌊", title: "Steady", line: "Plan as usual: 45-minute blocks with short breaks." },
  stretched: { emoji: "🌤️", title: "A bit stretched", line: "A few blocks slipped. Blocks are shorter, breaks longer, and goals are 15% lighter this week." },
  overloaded: { emoji: "🫶", title: "Taking it easier", line: "A lot slipped lately. Blocks are 25 minutes, goals are 40% lighter, and only schoolwork that is due soon gets pushed. Sleep stays protected." },
};

/** Recent hit rate for display, e.g. 7 of the last 10 blocks. */
export function recentRecord(m: Momentum, n = 10): { hits: number; total: number } {
  const scored = m.events.filter((e) => value(e) !== null).slice(-n);
  return { hits: scored.reduce((a, e) => a + (value(e) ?? 0), 0), total: scored.length };
}

function sessionCovers(b: Block, sessions: Session[], used: Set<string>): Session | undefined {
  const s = parseLocal(b.start).getTime(), e = parseLocal(b.end).getTime();
  const slop = 10 * 60000;
  return sessions.find((x) => {
    if (used.has(x.id)) return false;
    const end = new Date(x.ended_at).getTime();
    const start = end - x.actual_min * 60000;
    const same = b.task_id ? x.task_id === b.task_id : x.bucket === b.bucket;
    const overlap = Math.min(e, end + slop) - Math.max(s, start - slop);
    return same && overlap >= Math.min(10 * 60000, (e - s) / 2);
  });
}

/**
 * Close out blocks whose time has passed: credited when a matching study session overlaps,
 * otherwise marked missed. Returns the number of blocks that changed. Mutates `state`.
 * The caller re-plans afterwards, which re-places the missed minutes automatically.
 */
export function reconcile(state: State, now: Date): { changed: number; missed: Block[] } {
  const m = state.momentum ?? emptyMomentum(now);
  const seen = new Set(m.events.map((e) => e.key).filter(Boolean));
  const missed: Block[] = [];
  const used = new Set<string>();
  let changed = 0;
  for (const b of state.blocks) {
    if (b.status !== "planned") continue;
    if (parseLocal(b.end).getTime() + GRACE_MIN * 60000 > now.getTime()) continue;
    const s = sessionCovers(b, state.sessions, used);
    if (s) {
      used.add(s.id);
      b.status = "done";
      if (!seen.has(b.id)) m.events.push({ at: b.end, kind: s.actual_min >= 0.8 * s.planned_min ? "hit" : "partial",
        minutes: s.actual_min, key: b.id, energy: (ENERGY[s.energy] !== undefined ? s.energy : undefined) as MomentumEvent["energy"] });
    } else {
      b.status = "missed";
      missed.push(b);
      if (!seen.has(b.id)) m.events.push({ at: b.end, kind: "miss", minutes: 0, key: b.id });
    }
    changed++;
  }
  state.momentum = recompute(m, now);
  return { changed, missed };
}

/** Record a finished Study Mode session against the baseline. */
export function recordSession(state: State, now: Date, s: { blockId?: string; planned: number; actual: number; energy?: string }): void {
  const m = state.momentum ?? emptyMomentum(now);
  if (s.blockId && m.events.some((e) => e.key === s.blockId)) return;
  m.events.push({ at: fmtLocal(now), kind: s.actual >= 0.8 * s.planned ? "hit" : "partial", minutes: s.actual,
    key: s.blockId, energy: (s.energy && ENERGY[s.energy] !== undefined ? s.energy : undefined) as MomentumEvent["energy"] });
  state.momentum = recompute(m, now);
}

/** Optional one-tap check-in (1 = rough .. 5 = great). */
export function checkIn(state: State, now: Date, mood: number): void {
  const m = state.momentum ?? emptyMomentum(now);
  m.events.push({ at: fmtLocal(now), kind: "checkin", mood: Math.max(1, Math.min(5, Math.round(mood))) });
  state.momentum = recompute(m, now);
}
