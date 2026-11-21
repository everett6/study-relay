// App engine: owns the store, the CfC net and the LLM client, and turns user actions,
// chat/voice commands and relay (MCP) edits into a consistent re-planned state.

import type { Block, Draft, InboxItem, State, Task, WorkFlag } from "../core/types";
import { classify, type FlagIn } from "../core/canvas";
import { TASK_TYPE } from "../ai/heuristics";
import { SCHOOL } from "../core/types";
import { addDays, fmtDate, fmtLocal, hm, hm12, parseLocal, startOfDay } from "../core/time";
import { focusFor, matchCourse, recordGrades, subjectFocus } from "../core/grades";
import { freeIntervals, plan, splitChunks, validateBlock, type PaceFn } from "../core/schedule";
import { Store, api } from "../core/store";
import { CfCScheduler, features } from "../ai/cfcScheduler";
import { applyEstimate, heuristicEstimate, matchTasks, resolveBucket, TASK_WORDS, type ToolCall } from "../ai/heuristics";
import { LLMClient } from "../ai/llmClient";
import { ADJUST, checkIn, emptyMomentum, reconcile, recordSession } from "../ai/momentum";

export const uid = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 10);

export interface Reply { text: string; tone?: "ok" | "warn" | "info"; data?: unknown }

/** Fingerprint of everything the planner reads. Plans are rebuilt whenever it changes. */
export function planKey(st: State): string {
  const parts = JSON.stringify([
    st.tasks.map((t) => [t.id, t.status, t.due_at, t.estimated_minutes, t.human_minutes, t.cognitive_load, t.preclear_by, t.course]),
    st.events.map((e) => [e.id, e.kind, e.start, e.end]),
    st.buckets.map((b) => [b.key, b.target_hours, b.logged_minutes, b.load]),
    st.rules,
    st.blocks.filter((b) => b.locked || b.status !== "planned").map((b) => [b.id, b.start, b.end, b.status, b.locked]),
    st.momentum?.mode,
    (st.grades ?? []).map((g) => [g.course, g.score, g.target, g.ignore, g.history[0]?.date, g.history[g.history.length - 1]?.date]),
  ]);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < parts.length; i++) { h ^= parts.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export class Engine {
  cfc: CfCScheduler;
  clock: () => Date;
  onTimer: (s: State["timer"]) => void = () => {};

  constructor(public store: Store, public llm: LLMClient, clock: () => Date = () => new Date()) {
    this.cfc = CfCScheduler.fromJSON(store.state.cfc);
    this.clock = clock;
    // One rule for every edit, wherever it comes from (chat, drag, Canvas sync, settings, inbox):
    // if anything the planner reads changed, re-plan everything else around it.
    store.afterMutate = (st) => { if (planKey(st) !== st.meta.plan_key) this.replanInto(st); };
  }

  get state(): State { return this.store.state; }

  /** Called after every load/pull: adopt the synced CfC weights and handle relay-side edits. */
  afterSync(force = false): void {
    const s = this.state;
    if (s.cfc && (s.cfc.updates ?? 0) > this.cfc.updates) this.cfc = CfCScheduler.fromJSON(s.cfc);
    const now = this.clock();
    const pendingMiss = s.blocks.some((b) => b.status === "planned" && parseLocal(b.end).getTime() + 20 * 60000 < now.getTime());
    const changed = planKey(s) !== s.meta.plan_key; // e.g. Claude edited a task over MCP, or another device did
    if (force || changed || s.feedback.length || s.meta.needs_replan || pendingMiss || !s.momentum) {
      this.store.update((st) => {
        this.consumeFeedback(st);
        this.replanInto(st, now);
      });
    }
  }

  private energyNow(st: State): string {
    const e = st.momentum?.energy ?? 0.6;
    return e < 0.33 ? "low" : e > 0.7 ? "high" : "med";
  }

  pace(st: State): PaceFn {
    const energy = this.energyNow(st);
    const eventDays = new Set(st.events.filter((e) => e.kind === "event").map((e) => e.start.slice(0, 10)));
    return (at, taskType, minutes, key) =>
      this.cfc.predict(at, features(at, taskType, minutes, this.cfc.paceFor(key), energy, eventDays.has(fmtDate(at))));
  }

  /** Train the CfC on feedback queued by MCP tools or other devices. */
  consumeFeedback(st: State): void {
    for (const f of st.feedback) {
      if (!(f.ai_minutes > 0 && f.real_minutes > 0)) continue;
      const at = new Date(f.at);
      const at2 = Number.isNaN(at.getTime()) ? this.clock() : at;
      this.cfc.observe(at2, features(at2, f.task_type || "HW", f.ai_minutes, this.cfc.paceFor(f.course || f.bucket),
        f.energy ?? this.energyNow(st), false), f.real_minutes / f.ai_minutes, f.course || f.bucket);
    }
    st.feedback = [];
    st.cfc = this.cfc.toJSON();
  }

  /** Close out passed blocks (hit/miss), update the baseline, then re-plan from now. */
  replanInto(st: State, now = this.clock()): { missed: Block[] } {
    st.momentum ??= emptyMomentum(now);
    if (st.timer.state !== "idle" && st.timer.block_id) { // keep the block being worked on in place
      const running = st.blocks.find((b) => b.id === st.timer.block_id);
      if (running) running.locked = true;
    }
    const { missed } = reconcile(st, now);
    const res = plan(st, now, { pace: this.pace(st), newId: uid, adjust: ADJUST[st.momentum!.mode] });
    st.blocks = res.blocks.filter((b) => parseLocal(b.start) > addDays(startOfDay(now), -14)); // trim old history
    st.meta.at_risk = res.atRisk;
    st.meta.needs_replan = false;
    st.meta.plan_key = planKey(st);
    return { missed };
  }

  replan(): void { this.store.update((st) => { this.replanInto(st); }); }

  async estimateMissing(): Promise<number> {
    const todo = this.state.tasks.filter((t) => t.status === "open" && !t.estimated_minutes);
    if (!todo.length) return 0;
    // Always seed instant heuristic estimates first so the Matrix renders immediately on any browser.
    this.store.update((st) => {
      const byId = new Map(st.tasks.map((x) => [x.id, x]));
      for (const t of todo) {
        const cur = byId.get(t.id);
        if (cur) applyEstimate(cur, heuristicEstimate(cur), st.rules.block_min, st.rules.min_block_min);
      }
      this.replanInto(st);
    });
    if (!this.llm.ready) return todo.length;
    const focus = subjectFocus(this.state, this.clock());
    const refined: [string, ReturnType<typeof heuristicEstimate>][] = [];
    for (const t of todo) {
      const e = await this.llm.estimate(t, this.state.tasks, focusFor(focus, t.course));
      if (e.source === "llm") refined.push([t.id, e]);
    }
    if (refined.length) {
      this.store.update((st) => {
        const byId = new Map(st.tasks.map((x) => [x.id, x]));
        for (const [id, e] of refined) {
          const cur = byId.get(id);
          if (cur && cur.human_minutes == null) applyEstimate(cur, e, st.rules.block_min, st.rules.min_block_min);
        }
        this.replanInto(st);
      });
    }
    return todo.length;
  }

  /** Human correction from the matrix: exact override + an online CfC update. */
  correctEstimate(taskId: string, minutes: number): void {
    const now = this.clock();
    this.store.update((st) => {
      const t = st.tasks.find((x) => x.id === taskId);
      if (!t) return;
      const ai = t.llm_minutes || t.estimated_minutes;
      t.human_minutes = Math.round(minutes);
      t.est_source = "human";
      t.recommended_45m_blocks = splitChunks(t.human_minutes, st.rules.block_min, st.rules.min_block_min);
      if (ai > 0) this.cfc.observe(now, features(now, t.task_type, ai, this.cfc.paceFor(t.course), this.energyNow(st), false), minutes / ai, t.course);
      st.cfc = this.cfc.toJSON();
      this.replanInto(st, now);
    });
  }

  /** Save fresh Canvas grades (adds today's point to each course's history); the plan follows via planKey. */
  updateGrades(fresh: { course: string; score: number | null; grade: string | null }[], now = this.clock()): void {
    if (!fresh.length) return;
    this.store.update((st) => { st.grades = recordGrades(st.grades, fresh, now); });
  }

  /** Save the latest zeros / missing work. Missing work Canvas still accepts gets a make-up task right away;
   *  anything no longer flagged (turned in, regraded) drops off and its make-up task closes. */
  updateFlags(fresh: FlagIn[], now = this.clock()): { added: number; planned: number } {
    let added = 0, planned = 0;
    this.store.update((st) => {
      const old = new Map((st.flags ?? []).map((f) => [f.id, f]));
      const next: WorkFlag[] = [];
      for (const f of fresh) {
        const prev = old.get(f.id);
        const flag: WorkFlag = { ...f, status: prev?.status ?? "open", task_id: prev?.task_id, seen: fmtLocal(now) };
        // only recent missing work gets make-up time automatically; older items are just flagged
        const recent = !!f.due_at && parseLocal(f.due_at).getTime() > now.getTime() - 14 * 86400000;
        if (!prev) { added++; if (f.kind === "missing" && f.can_submit && recent) { this.makeupInto(st, flag, now); planned++; } }
        next.push(flag);
        old.delete(f.id);
      }
      for (const gone of old.values()) { // fixed on Canvas: close its make-up task
        const t = gone.task_id ? st.tasks.find((x) => x.id === gone.task_id) : undefined;
        if (t && t.status === "open") t.status = "done";
      }
      // Clean up any legacy redo tasks (there are no redo assignments).
      st.tasks = st.tasks.filter((t) => !(t.source === "makeup" && t.title.startsWith("Redo: ")));
      st.flags = next.filter((f) => f.kind !== "zero");
    });
    return { added, planned };
  }

  /** Add a make-up task for a flagged missing assignment, due in two days, so the planner fits it in first. */
  private makeupInto(st: State, f: WorkFlag, now: Date): void {
    const id = `makeup-${f.id}`;
    if (!st.tasks.some((t) => t.id === id)) {
      const due = addDays(startOfDay(now), 2); due.setHours(21, 0);
      const cat = classify(f.title);
      const t: Task = { id, source: "makeup", course: f.course, title: `Make up: ${f.title}`,
        description: `Missing on Canvas (${f.points} pts). Turn it in late.`,
        category: cat, task_type: TASK_TYPE[cat], points: f.points, due_at: fmtLocal(due), cognitive_load: 3, llm_minutes: 0,
        estimated_minutes: 0, human_minutes: null, confidence: 0, recommended_45m_blocks: [], est_source: "heuristic", logged_minutes: 0, status: "open" };
      applyEstimate(t, heuristicEstimate(t), st.rules.block_min, st.rules.min_block_min);
      st.tasks.push(t);
    } else {
      const t = st.tasks.find((x) => x.id === id)!;
      t.status = "open";
    }
    f.status = "planned";
    f.task_id = id;
  }

  planMakeup(flagId: string): void {
    this.store.update((st) => { const f = st.flags?.find((x) => x.id === flagId); if (f) this.makeupInto(st, f, this.clock()); });
  }

  /** Take a planned make-up back off the plan (the flag stays). */
  unplanMakeup(flagId: string): void {
    this.store.update((st) => {
      const f = st.flags?.find((x) => x.id === flagId);
      if (!f) return;
      if (f.task_id) st.tasks = st.tasks.filter((t) => t.id !== f.task_id);
      f.task_id = undefined;
      f.status = "open";
    });
  }

  /** Hide a flag (excused, can't be made up). Its make-up task goes too. */
  dismissFlag(flagId: string): void {
    this.store.update((st) => {
      const f = st.flags?.find((x) => x.id === flagId);
      if (!f) return;
      f.status = "dismissed";
      if (f.task_id) st.tasks = st.tasks.filter((t) => t.id !== f.task_id);
      f.task_id = undefined;
    });
  }

  /** A draft (never sent automatically) asking the teacher about late/missing work. */
  draftTeacherEmail(flagId: string): Draft | null {
    const f = this.state.flags?.find((x) => x.id === flagId);
    if (!f) return null;
    const what = `I didn't turn in “${f.title}”`;
    return this.addDraft({ to: `${f.course} teacher`, subject: `${f.course}: ${f.title}`, reason: `missing work in ${f.course}`,
      body: `Hi,\n\n${what}${f.due_at ? ` (due ${new Date(f.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}. Could I still turn it in for partial credit? If so, when would you need it by?\n\nThank you,\n` });
  }

  /** Set (or clear) the goal for one class; below-goal classes get more time and weekly review. */
  setGradeTarget(course: string, target: number | null, now = this.clock()): { ok: boolean; text: string } {
    const grades = this.state.grades ?? [];
    const hit = matchCourse(grades, course);
    if (!hit) return { ok: false, text: grades.length ? `I couldn't find a class called “${course}”.` : "I don't have your grades yet. Tap Sync Canvas first." };
    this.store.update((st) => { const g = st.grades?.find((x) => x.course === hit.course); if (g) g.target = target; });
    const f = subjectFocus(this.state, now).find((x) => x.course === hit.course);
    if (!f) return { ok: true, text: `${hit.course}: goal saved.` };
    return { ok: true, text: f.reviewMin
      ? `${hit.course}: goal ${f.target}%. You're at ${f.score}%, so I added ${f.reviewMin} min of review a week and give its homework ${Math.round((f.boost - 1) * 100)}% more time.`
      : `${hit.course}: goal ${f.target}%. You're at ${f.score}%, which already meets it.` };
  }

  setGradeIgnore(course: string, ignore: boolean): void {
    this.store.update((st) => { const g = st.grades?.find((x) => x.course === course); if (g) g.ignore = ignore; });
  }

  setTaskLoad(taskId: string, load: number): void {
    this.store.update((st) => { const t = st.tasks.find((x) => x.id === taskId); if (t) t.cognitive_load = load; this.replanInto(st); });
  }

  markDone(taskId: string, done = true): void {
    this.store.update((st) => { const t = st.tasks.find((x) => x.id === taskId); if (t) t.status = done ? "done" : "open"; this.replanInto(st); });
  }

  /** Manual drag/drop or edit of a block; locked so the planner respects it. */
  moveBlock(id: string, date: string, startHM: string): string | null {
    const b = this.state.blocks.find((x) => x.id === id);
    if (!b) return "block not found";
    const dur = (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000;
    const s = parseLocal(`${date}T${startHM}`);
    const e = new Date(s.getTime() + dur * 60000);
    const err = validateBlock(this.state.rules, this.state.events, fmtLocal(s), fmtLocal(e));
    if (err) return err;
    this.store.update((st) => {
      const x = st.blocks.find((y) => y.id === id);
      if (!x) return;
      Object.assign(x, { date, start: fmtLocal(s), end: fmtLocal(e), locked: true });
      this.replanInto(st);
    });
    return null;
  }

  /** Put all remaining work for one task on `date` (inside `window` if given), as kept blocks. */
  scheduleTaskOn(taskId: string, date: string, window: string | null, now = this.clock()): { placed: number; short: number } {
    const st = this.state;
    const t = st.tasks.find((x) => x.id === taskId);
    if (!t) return { placed: 0, short: 0 };
    const r = st.rules;
    const lockedElsewhere = st.blocks.filter((b) => b.task_id === taskId && b.locked && b.date !== date && b.status === "planned")
      .reduce((m, b) => m + (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000, 0);
    const need = Math.max(0, (t.human_minutes ?? t.estimated_minutes) - t.logged_minutes - lockedElsewhere);
    const chunks = splitChunks(need, r.block_min, r.min_block_min);
    const ranges: Record<string, [number, number]> = { morning: [360, 720], afternoon: [720, 1110], evening: [1110, 1439] };
    const [lo, hi] = window ? ranges[window] ?? [0, 1439] : [0, 1439];
    const day = parseLocal(`${date}T00:00`);
    const busy: [Date, Date][] = st.blocks.filter((b) => b.date === date && b.task_id !== taskId && (b.locked || b.status === "done"))
      .map((b) => [parseLocal(b.start), parseLocal(b.end)]);
    const placed: Block[] = [];
    for (const len of chunks) {
      const iv = freeIntervals(r, day, st.events, busy, now).find((x) => {
        const s0 = Math.max(x.s.getHours() * 60 + x.s.getMinutes(), lo), e0 = Math.min(x.e.getHours() * 60 + x.e.getMinutes(), hi);
        return e0 - s0 >= len;
      });
      if (!iv) break;
      const s = new Date(day.getTime() + Math.max(iv.s.getHours() * 60 + iv.s.getMinutes(), lo) * 60000);
      const e = new Date(s.getTime() + len * 60000);
      busy.push([s, new Date(e.getTime() + r.break_min * 60000)]);
      placed.push({ id: uid(), date, start: fmtLocal(s), end: fmtLocal(e), kind: "task", task_id: t.id, bucket: SCHOOL,
        title: `${t.course}: ${t.title}`, load: t.cognitive_load, quiet: false, locked: true, status: "planned" });
    }
    const mins = placed.reduce((m, b) => m + (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000, 0);
    if (placed.length) {
      this.store.update((s) => {
        s.blocks = s.blocks.filter((b) => !(b.task_id === taskId && b.status === "planned" && (!b.locked || b.date === date))).concat(placed);
        this.replanInto(s, now);
      });
    }
    return { placed: Math.round(mins), short: Math.max(0, Math.round(need - mins)) };
  }

  /** Make `first` come before `then` on a day by swapping their slots (both become kept). */
  orderBlocks(first: string, then: string, date: string, now = this.clock()): { ok: boolean; text: string } {
    const st = this.state;
    const find = (q: string) => {
      const wantTask = TASK_WORDS.test(q) ? matchTasks(q, st.tasks.filter((t) => t.status === "open"))[0] : undefined;
      const key = wantTask ? null : resolveBucket(q, st.buckets);
      const task = key ? undefined : wantTask ?? matchTasks(q, st.tasks.filter((t) => t.status === "open"))[0];
      return st.blocks.filter((b) => b.date === date && b.status === "planned" && parseLocal(b.end) > now
        && (key ? b.kind === "bucket" && b.bucket === key : !!task && b.task_id === task.id)).sort((x, y) => x.start.localeCompare(y.start))[0];
    };
    const a = find(first), b = find(then);
    if (!a || !b) return { ok: false, text: `I need both on ${date}'s plan; I couldn't find ${!a ? first : then} there.` };
    if (a.start < b.start) {
      this.store.update((s) => { for (const x of s.blocks) if (x.id === a.id || x.id === b.id) x.locked = true; this.replanInto(s, now); });
      return { ok: true, text: `${first} is already before ${then}. I kept both in place.` };
    }
    const lenA = parseLocal(a.end).getTime() - parseLocal(a.start).getTime();
    const lenB = parseLocal(b.end).getTime() - parseLocal(b.start).getTime();
    const s0 = parseLocal(b.start), aEnd = parseLocal(a.end);
    const newA: [string, string] = [fmtLocal(s0), fmtLocal(new Date(s0.getTime() + lenA))];
    // keep both inside the slots they had: the later one ends where the earlier one ended,
    // so a dinner or event between them stays between them
    let sB = new Date(aEnd.getTime() - lenB);
    if (sB.getTime() < s0.getTime() + lenA + st.rules.break_min * 60000) {
      const gap = Math.max(st.rules.break_min * 60000, parseLocal(a.start).getTime() - parseLocal(b.end).getTime());
      sB = new Date(s0.getTime() + lenA + gap);
    }
    const newB: [string, string] = [fmtLocal(sB), fmtLocal(new Date(sB.getTime() + lenB))];
    for (const [s, e] of [newA, newB]) {
      const err = validateBlock(st.rules, st.events, s, e);
      if (err) return { ok: false, text: `Can't swap them: ${err}.` };
    }
    this.store.update((s) => {
      for (const x of s.blocks) {
        if (x.id === a.id) Object.assign(x, { start: newA[0], end: newA[1], locked: true });
        if (x.id === b.id) Object.assign(x, { start: newB[0], end: newB[1], locked: true });
      }
      this.replanInto(s, now);
    });
    return { ok: true, text: `Swapped: ${first} at ${hm12(newA[0])}, then ${then} at ${hm12(newB[0])}.` };
  }

  removeBlock(id: string): void {
    this.store.update((st) => {
      const b = st.blocks.find((x) => x.id === id);
      if (!b) return;
      st.blocks = st.blocks.filter((x) => x.id !== id);
      // keep the planner from just putting it back today: blackout its slot
      st.events.push({ id: uid(), title: "Skipped block", kind: "blackout", start: b.start, end: b.end });
      this.replanInto(st);
    });
  }

  // ------------------------------------------------------------------ timer
  timerStart(opts: { blockId?: string; taskId?: string; bucket?: string; minutes?: number }): void {
    const now = this.clock();
    this.store.update((st) => {
      const b = opts.blockId ? st.blocks.find((x) => x.id === opts.blockId) : undefined;
      const planned = opts.minutes ?? (b ? (parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000 : st.rules.block_min);
      st.timer = { state: "running", block_id: b?.id, task_id: opts.taskId ?? b?.task_id, bucket: opts.bucket ?? b?.bucket ?? SCHOOL,
        planned_min: Math.round(planned), started_at: now.toISOString(), elapsed_sec: 0 };
    });
    this.onTimer(this.state.timer);
  }

  timerElapsed(t = this.state.timer): number {
    if (t.state !== "running" || !t.started_at) return t.elapsed_sec;
    return t.elapsed_sec + (this.clock().getTime() - new Date(t.started_at).getTime()) / 1000;
  }

  timerPause(): void {
    this.store.update((st) => {
      if (st.timer.state !== "running") return;
      st.timer.elapsed_sec = this.timerElapsed(st.timer);
      st.timer.state = "paused";
      delete st.timer.started_at;
    });
    this.onTimer(this.state.timer);
  }

  timerResume(): void {
    this.store.update((st) => { if (st.timer.state === "paused") { st.timer.state = "running"; st.timer.started_at = this.clock().toISOString(); } });
    this.onTimer(this.state.timer);
  }

  timerCancel(): void {
    this.store.update((st) => { st.timer = { state: "idle", elapsed_sec: 0 }; });
    this.onTimer(this.state.timer);
  }

  /**
   * Post-session check from Study Mode: logs time to the bucket/task, trains the CfC on
   * real vs. expected minutes, records a hit/partial for the baseline and re-plans.
   */
  setTimerNextAction(text: string): void {
    this.store.update((st) => {
      if (st.timer.state !== "idle") st.timer.next_action = text.trim() || undefined;
    });
  }

  finishSession(fb: { energy: "low" | "med" | "high"; outcome: "done" | "need_more" | "partial"; moreMinutes?: number; note?: string; confidence?: 1 | 2 | 3 }): void {
    const now = this.clock();
    this.store.update((st) => {
      const t = st.timer;
      if (t.state === "idle") return;
      const actual = Math.max(1, Math.round(this.timerElapsed(t) / 60));
      const planned = t.planned_min ?? st.rules.block_min;
      const bucket = st.buckets.find((b) => b.key === (t.bucket ?? SCHOOL));
      if (bucket) bucket.logged_minutes += actual;
      const note = fb.note?.trim() || undefined;
      st.sessions.push({ id: uid(), bucket: t.bucket ?? SCHOOL, task_id: t.task_id, planned_min: planned, actual_min: actual,
        energy: fb.energy, outcome: fb.outcome, ...(fb.confidence ? { confidence: fb.confidence } : {}), ...(note ? { note } : {}), ended_at: now.toISOString() });
      const block = t.block_id ? st.blocks.find((b) => b.id === t.block_id) : undefined;
      if (block) block.status = "done";
      const task = t.task_id ? st.tasks.find((x) => x.id === t.task_id) : undefined;
      if (task) {
        const est = task.human_minutes ?? task.estimated_minutes;
        task.logged_minutes += actual;
        if (fb.outcome === "done") {
          task.status = "done";
          if (est > 0) this.cfc.observe(now, features(now, task.task_type, est, this.cfc.paceFor(task.course), fb.energy, false),
            task.logged_minutes / est, task.course);
        } else if (fb.outcome === "need_more" && fb.moreMinutes) {
          const total = task.logged_minutes + fb.moreMinutes;
          if (est > 0) this.cfc.observe(now, features(now, task.task_type, est, this.cfc.paceFor(task.course), fb.energy, false), total / est, task.course);
          task.human_minutes = total;
          task.est_source = "human";
        }
      } else if (planned > 0 && fb.outcome !== "partial") { // bucket session: planned vs. how long a block's worth really took
        this.cfc.observe(now, features(now, "Goal", planned, this.cfc.paceFor("__buckets__"), fb.energy, false),
          Math.max(0.5, Math.min(2, planned / actual)), "__buckets__");
      }
      // If recall confidence was shaky (1) and a concept/note was captured, schedule a 20m spaced review in 2 days.
      if (fb.confidence === 1 && note) {
        const due = fmtLocal(addDays(now, 2)).slice(0, 11) + "21:00";
        st.tasks.push({
          id: `rev-${uid()}`, source: "manual", course: task?.course || (t.bucket ?? "Review"),
          title: `Review: ${note.slice(0, 80)}`, category: "quiz", task_type: "Quiz",
          due_at: due, cognitive_load: 3, llm_minutes: 20, estimated_minutes: 20,
          confidence: 0.85, recommended_45m_blocks: [20], est_source: "human", logged_minutes: 0, status: "open",
        });
      }
      recordSession(st, now, { blockId: block?.id, planned, actual, energy: fb.energy });
      st.timer = { state: "idle", elapsed_sec: 0 };
      st.cfc = this.cfc.toJSON();
      this.replanInto(st, now);
    });
    this.onTimer(this.state.timer);
  }

  cleanupImportedTasks(): number {
    const cutoff = addDays(this.clock(), -14).getTime();
    let removed = 0;
    this.store.update((st) => {
      const seen = new Set<string>();
      st.tasks = st.tasks.filter((t) => {
        if (t.status !== "open") return true;
        const key = `${t.course.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`;
        if (seen.has(key)) { removed++; return false; }
        seen.add(key);
        if (t.source !== "manual" && t.due_at && parseLocal(t.due_at).getTime() < cutoff) {
          t.status = "done";
          removed++;
        }
        return true;
      });
      if (removed) this.replanInto(st);
    });
    return removed;
  }

  clearSampleData(): number {
    let removed = 0;
    this.store.update((st) => {
      const before = st.tasks.length;
      st.tasks = st.tasks.filter((t) => !t.id.startsWith("canvas-900") && t.source !== "demo");
      removed = before - st.tasks.length;
      if (removed) this.replanInto(st);
    });
    return removed;
  }

  checkIn(mood: number): void {
    this.store.update((st) => { checkIn(st, this.clock(), mood); this.replanInto(st); });
  }

  // ------------------------------------------------------------------ tasks & inbox
  addTasks(tasks: Task[]): void {
    this.store.update((st) => {
      const ids = new Set(st.tasks.map((t) => t.id));
      for (const t of tasks) if (!ids.has(t.id)) st.tasks.push(t);
      this.replanInto(st);
    });
    void this.estimateMissing();
  }

  setInboxStatus(id: string, status: InboxItem["status"]): void {
    this.store.update((st) => { const it = st.inbox.find((x) => x.id === id); if (it) it.status = status; });
  }

  addInbox(item: Omit<InboxItem, "id" | "status" | "received_at" | "external_id">): void {
    this.store.update((st) => {
      st.inbox.push({ ...item, id: uid(), external_id: `local-${uid()}`, status: "new", received_at: fmtLocal(this.clock()) });
    });
  }

  /** Best guess at an address for "counselor", "Ms. Rivera", etc. from emails already seen. */
  resolveRecipient(who: string): string {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who.trim())) return who.trim();
    const w = who.toLowerCase().replace(/\b(my|the|teacher|mr|mrs|ms|dr)\.?\b/g, " ").trim();
    const items = [...this.state.inbox].reverse().filter((i) => i.source === "email");
    const hit = items.find((i) => (w.includes("counselor") && i.tags.includes("counselor")) ||
      (w && w.split(/\s+/).some((p) => p.length > 2 && i.from.toLowerCase().includes(p))));
    return hit?.from.match(/<([^>]+)>/)?.[1] ?? (hit?.from.includes("@") ? hit.from : "");
  }

  addDraft(d: Pick<Draft, "to" | "subject" | "body" | "reason"> & { inbox_id?: string }): Draft {
    const draft: Draft = { id: uid(), status: "draft", created_at: fmtLocal(this.clock()), ...d, to: this.resolveRecipient(d.to) || d.to };
    this.store.update((st) => { st.drafts.push(draft); });
    return draft;
  }

  updateDraft(id: string, patch: Partial<Pick<Draft, "to" | "subject" | "body">>): void {
    this.store.update((st) => { const d = st.drafts.find((x) => x.id === id); if (d) Object.assign(d, patch); });
  }

  deleteDraft(id: string): void { this.store.update((st) => { st.drafts = st.drafts.filter((x) => x.id !== id); }); }

  /** Only called from the Send button the student presses. */
  async sendDraft(id: string): Promise<void> {
    await this.store.flush();
    const d = this.state.drafts.find((x) => x.id === id);
    if (!d) throw new Error("draft not found");
    await api("/api/email/send", { draft_id: id, to: d.to, subject: d.subject, body: d.body });
    await this.store.pull();
  }

  // ------------------------------------------------------------------ chat & voice
  async run(text: string): Promise<Reply[]> {
    const now = this.clock();
    const { calls, reply, via } = await this.llm.command(text, this.state, now);
    const out: Reply[] = [];
    if (!calls.length) {
      out.push({ tone: "info", text: reply || "I didn't catch a change in that. Try “I have a banquet at 7 tonight”, “what's my grade in bio?”, or “start a focus session for AIME”." });
      return out;
    }
    for (const c of calls) out.push(await this.apply(c, text, now));
    if (reply && via === "llm") out.unshift({ tone: "info", text: reply });
    return out;
  }

  async apply(c: ToolCall, original: string, now: Date): Promise<Reply> {
    const a = c.args as Record<string, string>;
    const st = this.state;
    const findTask = (q: string) => matchTasks(q, st.tasks.filter((t) => t.status === "open"))[0];
    switch (c.tool) {
      case "add_event": {
        const end = a.end ?? fmtLocal(new Date(parseLocal(`${a.date}T${a.start}`).getTime() + 2 * 3600000)).slice(11);
        const start = parseLocal(`${a.date}T${a.start}`);
        const prepCut = new Date(start.getTime() - st.rules.event_prep_min * 60000);
        const horizon = addDays(startOfDay(start), 2);
        let pre = 0;
        this.store.update((s) => {
          s.events.push({ id: uid(), title: a.title, kind: "event", start: `${a.date}T${a.start}`, end: `${a.date}T${end}` });
          for (const t of s.tasks) {
            if (t.status !== "open" || !t.due_at) continue;
            const due = parseLocal(t.due_at);
            if (due < horizon && due > now) { t.preclear_by = fmtLocal(prepCut); pre++; }
          }
          this.replanInto(s, now);
        });
        const risk = this.state.meta.at_risk.length;
        return { tone: risk ? "warn" : "ok", text: `Added ${a.title} (${a.start}–${end}). ${pre ? `Moved ${pre} assignment${pre > 1 ? "s" : ""} due soon to before it.` : ""}${risk ? ` ${risk} item${risk > 1 ? "s are" : " is"} at risk; check Today.` : ""}`.trim() };
      }
      case "preclear_task": {
        const t = findTask(a.task_query);
        if (!t) return { tone: "warn", text: `I couldn't find a task matching “${a.task_query}”.` };
        this.store.update((s) => { const x = s.tasks.find((y) => y.id === t.id)!; x.preclear_by = `${a.date}T${a.before}`; this.replanInto(s, now); });
        return { tone: "ok", text: `${t.title} will be finished before ${a.before}.` };
      }
      case "cancel_study": {
        const after = a.after ?? (a.date === fmtDate(now) ? fmtLocal(now).slice(11) : "00:00");
        this.store.update((s) => {
          s.events.push({ id: uid(), title: "Night off", kind: "blackout", start: `${a.date}T${after}`, end: `${a.date}T${s.rules.sleep_cutoff}` });
          s.blocks = s.blocks.filter((b) => !(b.date === a.date && b.status === "planned" && b.end.slice(11) > after));
          this.replanInto(s, now);
        });
        return { tone: "ok", text: `Cleared study time on ${a.date} after ${after}. Anything due is rescheduled.` };
      }
      case "set_bucket_target": {
        const key = resolveBucket(String(a.bucket), st.buckets) ?? String(a.bucket).toUpperCase();
        if (!st.buckets.some((b) => b.key === key)) return { tone: "warn", text: `There's no goal called ${a.bucket}.` };
        this.store.update((s) => { s.buckets.find((b) => b.key === key)!.target_hours = Number(a.hours); this.replanInto(s, now); });
        return { tone: "ok", text: `${key} is now ${a.hours} h/week.` };
      }
      case "move_block": {
        const wantTask = TASK_WORDS.test(String(a.target)) ? findTask(String(a.target)) : undefined;
        const key = wantTask ? null : resolveBucket(String(a.target), st.buckets);
        const task = key ? undefined : wantTask ?? findTask(String(a.target));
        const ranges: Record<string, [string, string]> = { morning: ["06:00", "12:00"], afternoon: ["12:00", "18:30"], evening: ["18:30", "23:59"] };
        const [ws, we] = ranges[a.window as string] ?? ranges.afternoon;
        const day = parseLocal(`${a.to_date}T00:00`);
        const busy = st.blocks.filter((b) => b.date === a.to_date && (b.locked || b.status === "done")).map((b) => [parseLocal(b.start), parseLocal(b.end)] as [Date, Date]);
        const len = st.rules.block_min;
        const slot = freeIntervals(st.rules, day, st.events, busy, now).find((iv) => {
          const s = Math.max(iv.s.getHours() * 60 + iv.s.getMinutes(), hm(ws));
          const e = Math.min(iv.e.getHours() * 60 + iv.e.getMinutes(), hm(we));
          return e - s >= len;
        });
        if (!slot) return { tone: "warn", text: `No free ${len}-minute slot that ${a.window ?? "afternoon"} on ${a.to_date}.` };
        const sMin = Math.max(slot.s.getHours() * 60 + slot.s.getMinutes(), hm(ws));
        const s0 = new Date(day.getTime() + sMin * 60000), e0 = new Date(s0.getTime() + len * 60000);
        this.store.update((s) => {
          const today = fmtDate(now);
          if (key) { // drop one of today's planned blocks for that goal, if any
            const i = s.blocks.findIndex((b) => b.bucket === key && b.date === today && b.status === "planned" && !b.locked);
            if (i >= 0) s.blocks.splice(i, 1);
          }
          s.blocks.push({ id: uid(), date: a.to_date, start: fmtLocal(s0), end: fmtLocal(e0), kind: key ? "bucket" : "task",
            task_id: task?.id, bucket: key ?? SCHOOL, title: key ? s.buckets.find((b) => b.key === key)!.name : `${task?.course}: ${task?.title}`,
            load: key ? s.buckets.find((b) => b.key === key)!.load : task?.cognitive_load ?? 3, quiet: false, locked: true, status: "planned" });
          this.replanInto(s, now);
        });
        return { tone: "ok", text: `Pinned ${key ?? task?.title ?? a.target} on ${a.to_date} at ${fmtLocal(s0).slice(11)}.` };
      }
      case "schedule_task": {
        const t = findTask(String(a.task_query));
        if (!t) return { tone: "warn", text: `I couldn't find “${a.task_query}”.` };
        const r = this.scheduleTaskOn(t.id, String(a.date), (a.window as string) ?? null, now);
        return r.placed
          ? { tone: r.short ? "warn" : "ok", text: `${t.title}: ${r.placed} min on ${a.date}${r.short ? `. ${r.short} min didn't fit, so the planner fits it in elsewhere before it's due` : ""}.` }
          : { tone: "warn", text: `No free time on ${a.date}${a.window ? ` ${a.window}` : ""} for ${t.title}.` };
      }
      case "order_blocks": {
        const r = this.orderBlocks(String(a.first), String(a.then), (a.date as string) ?? fmtDate(now), now);
        return { tone: r.ok ? "ok" : "warn", text: r.text };
      }
      case "set_grade_target": {
        const r = this.setGradeTarget(String(a.course), a.target == null ? null : Number(a.target));
        return { tone: r.ok ? "ok" : "warn", text: r.text };
      }
      case "keep_block": {
        const wantTask = TASK_WORDS.test(String(a.target)) ? findTask(String(a.target)) : undefined;
        const key = wantTask ? null : resolveBucket(String(a.target), st.buckets);
        const task = key ? undefined : wantTask ?? findTask(String(a.target));
        if (!key && !task) return { tone: "warn", text: `I couldn't find “${a.target}” in your plan.` };
        const hit = (b: Block) => b.status === "planned" && (a.date ? b.date === a.date : parseLocal(b.end) > now)
          && (key ? b.bucket === key && b.kind === "bucket" : b.task_id === task!.id);
        const ids = st.blocks.filter(hit).sort((x, y) => x.start.localeCompare(y.start)).slice(0, a.date ? 9 : 1).map((b) => b.id);
        if (!ids.length) return { tone: "warn", text: `${key ?? task!.title} has no upcoming block to keep${a.date ? ` on ${a.date}` : ""}.` };
        this.store.update((s) => { for (const b of s.blocks) if (ids.includes(b.id)) b.locked = true; this.replanInto(s, now); });
        const first = this.state.blocks.find((b) => b.id === ids[0]);
        return { tone: "ok", text: `Kept ${key ?? task!.title}${first ? ` at ${hm12(first.start)} on ${first.date}` : ""}. Everything else can still shift around it.` };
      }
      case "set_estimate": {
        const t = findTask(a.task_query);
        if (!t) return { tone: "warn", text: `I couldn't find “${a.task_query}”.` };
        this.correctEstimate(t.id, Number(a.minutes));
        return { tone: "ok", text: `${t.title}: ${a.minutes} min. The model learned from that.` };
      }
      case "set_load": {
        const t = findTask(a.task_query);
        if (!t) return { tone: "warn", text: `I couldn't find “${a.task_query}”.` };
        this.setTaskLoad(t.id, Number(a.cognitive_load));
        return { tone: "ok", text: `${t.title} is now difficulty ${a.cognitive_load}/5.` };
      }
      case "mark_done": {
        const t = findTask(a.task_query);
        if (!t) return { tone: "warn", text: `I couldn't find “${a.task_query}”.` };
        this.markDone(t.id);
        return { tone: "ok", text: `Nice, ${t.title} is done. 🎉` };
      }
      case "ask_canvas": {
        const q = new URLSearchParams({ what: String(a.what) });
        if (a.course) q.set("course", String(a.course));
        if (a.search) q.set("search", String(a.search));
        try {
          const data = await api<Record<string, unknown>>(`/api/canvas/explore?${q}`);
          const smart = await this.llm.summarize(original, data);
          return { tone: "info", text: smart || summarizeCanvas(String(a.what), data), data };
        } catch (e) {
          return { tone: "warn", text: `Canvas lookup failed: ${String((e as Error).message ?? e)}` };
        }
      }
      case "timer": {
        const act = String(a.action);
        if (act === "pause") { this.timerPause(); return { tone: "ok", text: "Paused." }; }
        if (act === "resume") { this.timerResume(); return { tone: "ok", text: "Back to it." }; }
        if (act === "stop") return { tone: "info", text: "Tap Finish in Study Mode to log how it went." };
        const target = a.target ? String(a.target) : "";
        const key = target ? resolveBucket(target, st.buckets) ?? (st.buckets.some((b) => b.key === target) ? target : null) : null;
        const task = !key && target ? findTask(target) : undefined;
        const next = !target ? st.blocks.find((b) => b.status === "planned" && parseLocal(b.end) > now) : undefined;
        this.timerStart({ blockId: next?.id, taskId: task?.id, bucket: key ?? (task ? SCHOOL : undefined) });
        return { tone: "ok", text: `Focus session started: ${key ?? task?.title ?? next?.title ?? "study"}. You've got this.` };
      }
      case "draft_email": {
        const d = this.addDraft({ to: String(a.to), subject: String(a.subject), body: String(a.body), reason: String(a.reason ?? "you asked") });
        return { tone: "info", text: d.to.includes("@") ? `Drafted an email to ${d.to}. Review it in Inbox and press Send when ready.`
          : `Drafted it. I don't know ${a.to}'s address yet; add it in Inbox before sending.` };
      }
      case "check_in": {
        this.checkIn(Number(a.mood));
        const m = Number(a.mood);
        return { tone: "info", text: m <= 2 ? "Thanks for telling me. I lightened today: shorter blocks, more breaks. Deadlines are still covered."
          : m >= 4 ? "Love that. I'll keep the plan moving." : "Got it, keeping things steady." };
      }
    }
    return { tone: "warn", text: "Unknown command." };
  }
}

export function summarizeCanvas(what: string, data: Record<string, unknown>): string {
  const list = (data[what === "grades" ? "courses" : what] ?? data.courses ?? []) as Record<string, unknown>[];
  if (!Array.isArray(list) || !list.length) return "Nothing found on Canvas for that.";
  if (what === "grades" || what === "courses")
    return list.map((c) => `${c.course}: ${c.current_score ?? "—"}%${c.current_grade ? ` (${c.current_grade})` : ""}`).join(" · ");
  if (what === "assignments")
    return list.slice(0, 6).map((x) => `${x.missing ? "⚠️ " : ""}${x.title}${x.course ? ` [${x.course}]` : ""}${x.due_at ? ` (due ${new Date(String(x.due_at)).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })})` : ""}`).join(" · ");
  if (what === "announcements") return list.slice(0, 3).map((x) => `${x.course ? `${x.course}: ` : ""}${x.title}: ${String(x.text ?? "").slice(0, 120)}`).join("\n");
  if (what === "syllabus") return String(list[0].syllabus ?? "").slice(0, 400);
  return list.slice(0, 6).map((x) => `${x.course ? `${x.course}: ` : ""}${x.module ?? x.title ?? ""}`).join(" · ");
}
