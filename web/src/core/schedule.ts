// Browser-side planner: protected buffers -> free intervals -> block allocation.
// Guarantees (tested): never inside school, the after-school break, dinner, events or
// blackouts, never past the sleep cutoff. What does not fit is reported, not squeezed in.

import { SCHOOL, type AtRisk, type Block, type CalEvent, type Rules, type State, type Task } from "./types";
import { focusFor, subjectFocus } from "./grades";
import { addDays, atMin, fmtDate, fmtLocal, hm, isoDow, isoWeek, minutesBetween, mondayOf, parseLocal, startOfDay } from "./time";

export const REVIEW = "Review: ";
/** Planner key for a course's weekly review time (kept apart from the student's own goal buckets). */
const reviewKey = (title: string) => (title.startsWith(REVIEW) ? `REVIEW:${title.slice(REVIEW.length)}` : null);

export interface Fixed { kind: string; title: string; s: Date; e: Date }
interface Interval { s: Date; e: Date; quiet: [Date, Date][]; pace: number }

const MULTI_DAY = new Set(["test", "project"]);
const DAILY_CAP = 150; // soft daily study cap; due tasks and course reviews may exceed it
export const PREP_PREFIX = "Get ready: ";

/** US federal + public/private school holiday name if no school is held on d. */
export function schoolHolidayName(day: Date): string {
  const m = day.getMonth() + 1;
  const d = day.getDate();
  const wd = day.getDay(); // 0=Sun..6=Sat
  const isObserved = (month: number, target: number) => {
    if (m === month && d === target) return true;
    if (wd === 5) {
      const nxt = new Date(day.getFullYear(), day.getMonth(), d + 1);
      if (nxt.getMonth() + 1 === month && nxt.getDate() === target) return true;
    }
    if (wd === 1) {
      const prv = new Date(day.getFullYear(), day.getMonth(), d - 1);
      if (prv.getMonth() + 1 === month && prv.getDate() === target) return true;
    }
    return false;
  };
  if ((m === 12 && d >= 24) || (m === 1 && d === 1) || isObserved(1, 1)) return "Winter Break / New Year's";
  if (m === 1 && wd === 1 && d >= 15 && d <= 21) return "MLK Jr. Day";
  if (m === 2 && wd === 1 && d >= 15 && d <= 21) return "Presidents' Day";
  if (m === 5 && wd === 1 && d >= 25) return "Memorial Day";
  if (isObserved(6, 19)) return "Juneteenth";
  if (isObserved(7, 4)) return "Independence Day";
  if (m === 9 && wd === 1 && d <= 7) return "Labor Day";
  if (m === 10 && wd === 1 && d >= 8 && d <= 14) return "Indigenous Peoples' / Columbus Day";
  if (isObserved(11, 11)) return "Veterans Day";
  if (m === 11 && ((wd === 4 && d >= 22 && d <= 28) || (wd === 5 && d >= 23 && d <= 29))) return "Thanksgiving Break";
  return "";
}

export const isSchoolDay = (r: Rules, d: Date): boolean => !schoolHolidayName(d) && r.school_days.includes(isoDow(d));

/** The day's dismissal time, honouring per-weekday overrides (block days). */
export const schoolEnd = (r: Rules, d: Date): string => r.school_end_by_day?.[String(isoDow(d))] || r.school_end;

export function fixedSpans(r: Rules, day: Date, events: CalEvent[]): Fixed[] {
  const out: Fixed[] = [];
  const add = (kind: string, title: string, s: Date, e: Date) => { if (e > s) out.push({ kind, title, s, e }); };
  if (isSchoolDay(r, day)) {
    const end = hm(schoolEnd(r, day));
    const comm = Math.max(0, r.commute_min ?? 0);
    add("school", "School", atMin(day, hm(r.school_start)), atMin(day, end));
    if (comm > 0) add("buffer", "Commute", atMin(day, end), atMin(day, end + comm));
    add("buffer", "Snack & decompress", atMin(day, end + comm), atMin(day, end + comm + r.after_school_min));
  }
  const dn = hm(r.dinner_start);
  add("dinner", "Dinner & family", atMin(day, dn), atMin(day, dn + r.dinner_min));
  add("sleep", "Sleep (hard cutoff)", atMin(day, hm(r.sleep_cutoff)), atMin(day, 24 * 60));
  const d0 = startOfDay(day), d1 = addDays(d0, 1);
  for (const ev of events) {
    const s = parseLocal(ev.start), e = parseLocal(ev.end);
    if (e <= d0 || s >= d1) continue;
    if (ev.kind === "event" && r.event_prep_min > 0 && s >= d0)
      add("prep", PREP_PREFIX + ev.title, new Date(s.getTime() - r.event_prep_min * 60000), s);
    add(ev.kind, ev.title, s < d0 ? d0 : s, e > d1 ? d1 : e);
  }
  return out.sort((a, b) => a.s.getTime() - b.s.getTime());
}

export function studyWindow(r: Rules, day: Date): [Date, Date] {
  const start = isSchoolDay(r, day) ? hm(schoolEnd(r, day)) : hm(r.weekend_start);
  return [atMin(day, start), atMin(day, hm(r.sleep_cutoff))];
}

function quietRanges(r: Rules, day: Date): [Date, Date][] {
  const list = isSchoolDay(r, day) ? r.quiet_weekday : r.quiet_weekend;
  return list.map((x) => { const [a, b] = x.split("-"); return [atMin(day, hm(a)), atMin(day, hm(b))] as [Date, Date]; });
}

export function freeIntervals(r: Rules, day: Date, events: CalEvent[], busy: [Date, Date][], now?: Date): Interval[] {
  if ((r.rest_days ?? []).includes(isoDow(day))) return [];
  const [ws, we] = studyWindow(r, day);
  let pieces: [Date, Date][] = [[ws, we]];
  const blockers: [Date, Date][] = fixedSpans(r, day, events).map((f) => [f.s, f.e] as [Date, Date]).concat(busy);
  if (now && fmtDate(now) === fmtDate(day)) {
    const rounded = new Date(Math.ceil(now.getTime() / 300000) * 300000);
    blockers.push([startOfDay(day), rounded]);
  }
  for (const [bs, be] of blockers) {
    const next: [Date, Date][] = [];
    for (const [s, e] of pieces) {
      if (be <= s || bs >= e) { next.push([s, e]); continue; }
      if (bs > s) next.push([s, bs]);
      if (be < e) next.push([be, e]);
    }
    pieces = next;
  }
  const q = quietRanges(r, day);
  return pieces.sort((a, b) => a[0].getTime() - b[0].getTime())
    .filter(([s, e]) => minutesBetween(s, e) >= r.min_block_min)
    .map(([s, e]) => ({ s, e, quiet: q, pace: 1 }));
}

const isQuietMs = (iv: Interval, midMs: number): boolean =>
  iv.quiet.some(([a, b]) => a.getTime() <= midMs && midMs < b.getTime());

export function splitChunks(minutes: number, block: number, minBlock: number): number[] {
  minutes = Math.round(minutes);
  if (minutes <= 0) return [];
  const out: number[] = Array(Math.floor(minutes / block)).fill(block);
  const rem = minutes % block;
  if (!rem) return out;
  if (!out.length) return [Math.max(rem, minBlock)];
  if (rem >= minBlock) { out.push(rem); return out; }
  if (rem <= 10) { out[out.length - 1] += rem; return out; } // a few extra minutes on the last block
  // otherwise spread evenly (in 5-minute steps) so no block exceeds the block length or is a sliver
  const n = out.length + 1;
  const even = Array(n).fill(Math.floor(minutes / n / 5) * 5);
  let left = minutes - even.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % n) { const d = Math.min(5, left); even[i] += d; left -= d; }
  return even;
}

class Pool {
  constructor(public byDay: Map<string, Interval[]>, private brk: number, private minBlock: number) {}
  capacity(d: string): number { return (this.byDay.get(d) ?? []).reduce((a, iv) => a + minutesBetween(iv.s, iv.e), 0); }

  take(days: string[], minutes: number, deadline: Date | null, preferQuiet: boolean | null, usePace = false):
    { s: Date; e: Date; quiet: boolean } | null {
    const mb = this.minBlock;
    for (const d of days) {
      const cands: { iv: Interval; dur: number }[] = [];
      for (const iv of this.byDay.get(d) ?? []) {
        const end = deadline && deadline < iv.e ? deadline : iv.e;
        const avail = minutesBetween(iv.s, end);
        let dur = Math.min(minutes, avail);
        if (usePace && iv.pace > 1.3 && dur > 30) dur = 30; // CfC expects a slow slot: shorter block
        if (dur < minutes && minutes - dur < mb) dur = minutes - mb;
        if (dur >= Math.min(minutes, mb)) cands.push({ iv, dur });
      }
      if (!cands.length) continue;
      const rank = (c: { iv: Interval; dur: number }) => {
        const q = isQuietMs(c.iv, c.iv.s.getTime() + c.dur * 30000);
        return [preferQuiet === null ? 0 : q === preferQuiet ? 0 : 1, usePace ? Math.round(c.iv.pace * 100) : 0, c.iv.s.getTime()];
      };
      cands.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]; });
      const { iv, dur } = cands[0];
      const s = iv.s, e = new Date(s.getTime() + dur * 60000);
      const quiet = isQuietMs(iv, (s.getTime() + e.getTime()) / 2);
      const after = new Date(e.getTime() + this.brk * 60000);
      for (const o of this.byDay.get(d)!) if (o !== iv && o.s >= e && o.s < after) o.s = after;
      iv.s = after;
      this.byDay.set(d, this.byDay.get(d)!.filter((x) => minutesBetween(x.s, x.e) >= mb));
      return { s, e, quiet };
    }
    return null;
  }
}

export interface PlanResult { blocks: Block[]; atRisk: AtRisk[]; shortfall: Record<string, number> }
export type PaceFn = (at: Date, taskType: string, minutes: number, key: string) => number;

const effMinutes = (t: Task): number => t.human_minutes ?? t.estimated_minutes;

/** Re-plan everything from `now`: keeps done and locked blocks, regenerates the rest. */
/** Workload adjustments from the momentum baseline. Deadlines and sleep are never touched. */
export interface Adjust { blockMin?: number; breakMin?: number; tier2Factor?: number; dailyCap?: number }

export function plan(state: State, now: Date,
  opts: { horizonDays?: number; pace?: PaceFn; newId?: () => string; adjust?: Adjust } = {}): PlanResult {
  const adj = opts.adjust ?? {};
  const r = { ...state.rules, block_min: adj.blockMin ?? state.rules.block_min, break_min: adj.breakMin ?? state.rules.break_min };
  const dailyCap = adj.dailyCap ?? DAILY_CAP;
  const t2 = Math.min(1.2, Math.max(0.3, adj.tier2Factor ?? 1));
  const horizon = opts.horizonDays ?? 7;
  const newId = opts.newId ?? (() => Math.random().toString(36).slice(2, 10));
  const today = startOfDay(now);
  const days = Array.from({ length: horizon }, (_, i) => addDays(today, i));
  const dayKeys = days.map(fmtDate);
  const horizonEnd = addDays(today, horizon);

  const kept = state.blocks.filter((b) => b.status === "done" || b.locked || parseLocal(b.start) < now);
  const futureLocked = kept.filter((b) => b.status === "planned" && b.locked && parseLocal(b.start) >= now);
  const busy = new Map<string, [Date, Date][]>();
  const lockedTask = new Map<string, number>();
  const lockedBucketWeek = new Map<string, number>();
  for (const b of futureLocked) {
    const s = parseLocal(b.start), e = parseLocal(b.end);
    (busy.get(b.date) ?? busy.set(b.date, []).get(b.date)!).push([s, e]);
    if (b.task_id) lockedTask.set(b.task_id, (lockedTask.get(b.task_id) ?? 0) + minutesBetween(s, e));
    else { const k = `${reviewKey(b.title) ?? b.bucket}|${isoWeek(s)}`; lockedBucketWeek.set(k, (lockedBucketWeek.get(k) ?? 0) + minutesBetween(s, e)); }
  }
  // review time already done this week counts toward that week's review target
  for (const b of kept) {
    const rk = b.status === "done" ? reviewKey(b.title) : null;
    if (rk) { const k = `${rk}|${isoWeek(parseLocal(b.start))}`; lockedBucketWeek.set(k, (lockedBucketWeek.get(k) ?? 0) + minutesBetween(parseLocal(b.start), parseLocal(b.end))); }
  }
  // grades: below-goal or slipping classes get more homework time, an earlier start, and weekly review
  const focus = subjectFocus(state, now);

  const byDay = new Map<string, Interval[]>();
  days.forEach((d, i) => byDay.set(dayKeys[i], freeIntervals(r, d, state.events, busy.get(dayKeys[i]) ?? [], now)));
  if (opts.pace) for (const ivs of byDay.values()) for (const iv of ivs) iv.pace = opts.pace(iv.s, "Goal", r.block_min, "__buckets__");
  const pool = new Pool(byDay, r.break_min, r.min_block_min);
  const out: Block[] = [];
  const atRisk: AtRisk[] = [];
  const emit = (s: Date, e: Date, quiet: boolean, b: Partial<Block>) =>
    out.push({ id: newId(), date: fmtDate(s), start: fmtLocal(s), end: fmtLocal(e), quiet, locked: false, status: "planned",
      kind: "task", bucket: SCHOOL, title: "", load: 3, ...b });

  // ---------------------------------------------------------------- Tier 1
  const urgentCut = new Date(now.getTime() + r.preclear_hours * 3600000);
  type Req = { t: Task; mins: number; deadline: Date; due: Date | null; urgent: boolean; preclear: boolean };
  const reqs: Req[] = [];
  for (const t of state.tasks) {
    if (t.status !== "open") continue;
    let mins = effMinutes(t) - t.logged_minutes - (lockedTask.get(t.id) ?? 0);
    if (opts.pace && t.human_minutes == null) mins = Math.round((mins * opts.pace(now, t.task_type, mins, t.course)) / 5) * 5;
    const fb = t.human_minutes == null ? focusFor(focus, t.course)?.boost ?? 1 : 1;
    if (fb > 1) mins = Math.round((mins * fb) / 5) * 5;
    if (mins < 5) continue;
    const due = t.due_at ? parseLocal(t.due_at) : null;
    let pre = t.preclear_by ? parseLocal(t.preclear_by) : null;
    if (pre && pre <= now) pre = null;
    let deadline = pre ?? due ?? horizonEnd;
    let late = false;
    if (deadline <= now) { deadline = horizonEnd; late = true; }
    reqs.push({ t, mins, deadline, due, urgent: late || !!pre || deadline <= urgentCut, preclear: !!pre });
  }
  const tier1Day = new Map<string, number>(), taskDay = new Map<string, number>();
  for (const b of kept) {
    if (b.status !== "done" && !b.locked) continue;
    const start = parseLocal(b.start), end = parseLocal(b.end), day = fmtDate(start);
    if (dayKeys.includes(day)) tier1Day.set(day, (tier1Day.get(day) ?? 0) + minutesBetween(start, end));
  }
  const between = (a: Date, b: Date) => dayKeys.filter((_k, i) => days[i] >= startOfDay(a) && days[i] <= startOfDay(b));

  const placeTask = ({ t, mins, deadline, due, urgent, preclear }: Req) => {
    const chunks = splitChunks(mins, r.block_min, r.min_block_min);
    const weak = focusFor(focus, t.course)?.level === "focus";
    const first = urgent ? today : t.category && MULTI_DAY.has(t.category)
      ? addDays(startOfDay(deadline), -(Math.ceil(chunks.length / 2) + 1 + (weak ? 1 : 0)))
      : addDays(startOfDay(deadline), weak ? -4 : -3);
    const window = between(first < today ? today : first, deadline);
    const prefer = t.cognitive_load >= 4 || weak ? true : (urgent ? null : false);
    let unplaced = 0;
    const title = t.course ? `${t.course}: ${t.title}` : t.title;
    const put = (c: number, win: string[], dl: Date, useCaps: boolean): boolean => {
      let got = null;
      if (useCaps) {
        const ok = win.filter((d) => (tier1Day.get(d) ?? 0) + c <= dailyCap &&
          (!MULTI_DAY.has(t.category) || (taskDay.get(`${t.id}|${d}`) ?? 0) < 2 * r.block_min));
        got = pool.take(ok, c, dl, prefer);
      }
      got ??= pool.take(win, c, dl, prefer);
      if (!got) return false;
      const dur = minutesBetween(got.s, got.e);
      if (dur < c) chunks.unshift(c - dur);
      const d = fmtDate(got.s);
      tier1Day.set(d, (tier1Day.get(d) ?? 0) + dur);
      taskDay.set(`${t.id}|${d}`, (taskDay.get(`${t.id}|${d}`) ?? 0) + dur);
      emit(got.s, got.e, got.quiet, { kind: "task", task_id: t.id, bucket: SCHOOL, title, load: t.cognitive_load });
      return true;
    };
    while (chunks.length) { const c = chunks.shift()!; if (!put(c, window, deadline, !urgent)) unplaced += c; }
    if (unplaced && preclear && due && due > deadline) {
      const moved = unplaced; unplaced = 0;
      const spill = splitChunks(moved, r.block_min, r.min_block_min);
      chunks.push(...spill);
      while (chunks.length) { const c = chunks.shift()!; if (!put(c, between(today, due), due, false)) unplaced += c; }
      atRisk.push({ task_id: t.id, title: t.title, minutes: moved,
        reason: `only part fits before the pre-clear time; ${moved} min moved after it (still before the due time)` });
    }
    // work for deadlines past the horizon is planned later as days roll into view: not at risk
    if (unplaced && deadline <= horizonEnd) atRisk.push({ task_id: t.id, title: t.title, minutes: unplaced,
      reason: "not enough free time before the deadline (sleep and buffers are protected)" });
  };
  reqs.filter((x) => x.urgent).sort((a, b) => a.deadline.getTime() - b.deadline.getTime() || b.t.cognitive_load - a.t.cognitive_load).forEach(placeTask);
  reqs.filter((x) => !x.urgent).sort((a, b) => a.deadline.getTime() - b.deadline.getTime()).forEach(placeTask);

  // ---------------------------------------------------------------- Tier 2 buckets
  const shortfall: Record<string, number> = {};
  const buckets = state.buckets.filter((b) => b.key !== SCHOOL && b.target_hours > 0)
    .concat(focus.filter((f) => f.reviewMin > 0).map((f) => ({ key: `REVIEW:${f.course}`, name: `${REVIEW}${f.course}`,
      target_hours: f.reviewMin / 60, logged_minutes: 0, week: "", load: 4 })));
  const weeks = new Map<string, Date[]>();
  days.forEach((d) => { const w = isoWeek(d); (weeks.get(w) ?? weeks.set(w, []).get(w)!).push(d); });
  const thisWeek = isoWeek(now);
  for (const [wk, wdays] of weeks) {
    const mon = mondayOf(wdays[0]);
    const all = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    const caps = new Map<string, number>();
    for (const d of all) {
      const k = fmtDate(d);
      caps.set(k, d < today ? 0 : byDay.has(k) ? pool.capacity(k)
        : freeIntervals(r, d, state.events, []).reduce((a, iv) => a + minutesBetween(iv.s, iv.e), 0));
    }
    const queue = new Map<string, { b: (typeof buckets)[number]; c: number }[]>();
    const sessions: { b: (typeof buckets)[number]; cs: number[] }[] = [];
    for (const b of buckets) {
      const target = Math.round((b.target_hours * 60 * t2) / 5) * 5;
      let remaining = wk === thisWeek && b.week === thisWeek ? target - b.logged_minutes : target;
      remaining -= lockedBucketWeek.get(`${b.key}|${wk}`) ?? 0;
      const chunks = splitChunks(Math.max(0, remaining), r.block_min, r.min_block_min);
      if (!chunks.length) continue;
      // a session = up to two back-to-back blocks of the same goal (one sitting, one subject)
      for (let i = 0; i < chunks.length; i += 2) sessions.push({ b, cs: chunks.slice(i, i + 2) });
    }
    // Give each session a day: spread a goal over different days, keep few subjects per day,
    // and fill days in proportion to their free time. Unplaceable minutes are a shortfall.
    const elig = all.map(fmtDate).filter((k) => (caps.get(k) ?? 0) > 0);
    const used = new Map(elig.map((k) => [k, 0]));
    const subj = new Map(elig.map((k) => [k, new Set<string>()]));
    const maxSubj = (k: string) => (isSchoolDay(r, parseLocal(`${k}T12:00:00`)) ? 3 : 4);
    const sesMin = (x: { cs: number[] }) => x.cs.reduce((a, c) => a + c, 0) + (x.cs.length - 1) * r.break_min;
    sessions.sort((a, z) => sesMin(z) - sesMin(a) || z.b.load - a.b.load);
    for (const ses of sessions) {
      const need = sesMin(ses);
      const fits = (k: string) => used.get(k)! + need <= caps.get(k)!;
      const score = (k: string) => (used.get(k)! + need) / caps.get(k)!;
      const pick = (ok: (k: string) => boolean) => elig.filter((k) => fits(k) && ok(k)).sort((a, z) => score(a) - score(z) || a.localeCompare(z))[0];
      const k = pick((d) => !subj.get(d)!.has(ses.b.key) && subj.get(d)!.size < maxSubj(d))
        ?? pick((d) => subj.get(d)!.has(ses.b.key) || subj.get(d)!.size < maxSubj(d))
        ?? pick(() => true);
      if (!k) {
        if (!elig.length || elig.every((d) => caps.get(d)! < r.min_block_min)) { shortfall[ses.b.key] = (shortfall[ses.b.key] ?? 0) + need; continue; }
        // nothing fits whole: put it on the roomiest day and let the day's pass carry what is left
        const roomy = [...elig].sort((a, z) => (caps.get(z)! - used.get(z)!) - (caps.get(a)! - used.get(a)!))[0];
        (queue.get(roomy) ?? queue.set(roomy, []).get(roomy)!).push(...ses.cs.map((c) => ({ b: ses.b, c })));
        used.set(roomy, used.get(roomy)! + need); subj.get(roomy)!.add(ses.b.key);
        continue;
      }
      used.set(k, used.get(k)! + need); subj.get(k)!.add(ses.b.key);
      (queue.get(k) ?? queue.set(k, []).get(k)!).push(...ses.cs.map((c) => ({ b: ses.b, c })));
    }
    let carry: { b: (typeof buckets)[number]; c: number }[] = [];
    for (const k of [...new Set([...queue.keys(), ...wdays.map(fmtDate)])].sort()) {
      const items = carry.concat(queue.get(k) ?? []);
      carry = [];
      if (!byDay.has(k)) continue;
      // Alternate subjects so a day's limited study budget is not spent on one goal.
      const grouped = new Map<string, typeof items>();
      for (const it of items) (grouped.get(it.b.key) ?? grouped.set(it.b.key, []).get(it.b.key)!).push(it);
      const groups = [...grouped.values()]
        .sort((a, z) => Number(!a[0].b.key.startsWith("REVIEW:")) - Number(!z[0].b.key.startsWith("REVIEW:")) || z[0].b.load - a[0].b.load);
      const ordered: typeof items = [];
      while (groups.some((group) => group.length)) {
        for (const group of groups) {
          const next = group.shift();
          if (next) ordered.push(next);
        }
      }
      for (const { b, c } of ordered) {
        let left = c;
        while (left >= r.min_block_min) {
          const usedToday = tier1Day.get(k) ?? 0;
          const roomToday = dailyCap + (b.key.startsWith("REVIEW:") ? r.block_min : 0) - usedToday;
          if (roomToday < r.min_block_min) break;
          const got = pool.take([k], Math.min(left, roomToday), null, b.load >= 4, !!opts.pace);
          if (!got) break;
          const placed = minutesBetween(got.s, got.e);
          left -= placed;
          tier1Day.set(k, usedToday + placed);
          emit(got.s, got.e, got.quiet, { kind: "bucket", bucket: b.key.startsWith("REVIEW:") ? SCHOOL : b.key, title: b.name, load: b.load });
        }
        if (left >= r.min_block_min) carry.push({ b, c: left });
      }
    }
    const lastWeek = isoWeek(days[days.length - 1]);
    if (!(wk === lastWeek && fmtDate(wdays[wdays.length - 1]) < fmtDate(all[6])))
      for (const { b, c } of carry) shortfall[b.key] = (shortfall[b.key] ?? 0) + c;
  }

  const blocks = kept.concat(out).sort((a, b) => a.start.localeCompare(b.start));
  return { blocks, atRisk, shortfall };
}

/** Validate a manual edit against protected time. Returns an error message or null. */
export function validateBlock(r: Rules, events: CalEvent[], start: string, end: string): string | null {
  const s = parseLocal(start), e = parseLocal(end);
  if (e <= s || fmtDate(s) !== fmtDate(e)) return "block must start and end on the same day";
  const [ws, we] = studyWindow(r, s);
  if (s < ws || e > we) return "outside study hours (school or sleep cutoff)";
  for (const f of fixedSpans(r, s, events)) if (s < f.e && e > f.s) return `overlaps protected block: ${f.title}`;
  return null;
}
