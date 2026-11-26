// App engine: owns the store, the CfC net and the LLM client, and turns user actions,
// chat/voice commands and relay (MCP) edits into a consistent re-planned state.

import type { Block, Draft, InboxItem, State, Task, WorkFlag } from "../core/types";
import { classify, type FlagIn } from "../core/canvas";
import { TASK_TYPE } from "../ai/heuristics";
import { SCHOOL } from "../core/types";
import { addDays, fmtDate, fmtLocal, hm, hm12, parseLocal, startOfDay } from "../core/time";
import { focusFor, matchCourse, recordGrades, subjectFocus } from "../core/grades";
import { freeIntervals, isPianoItem, plan, splitChunks, validateBlock, type PaceFn } from "../core/schedule";
import { Store, api } from "../core/store";
import { CfCScheduler, features } from "../ai/cfcScheduler";
import { applyEstimate, heuristicEstimate, matchTasks, resolveBucket, resolveTarget, validateSchedulePatch, type ToolCall } from "../ai/heuristics";
import { LLMClient } from "../ai/llmClient";
import { ADJUST, checkIn, emptyMomentum, reconcile, recordSession } from "../ai/momentum";

export const uid = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 10);

export interface Reply { text: string; tone?: "ok" | "warn" | "info"; data?: unknown }

const TRACE_ACTIONS: Record<ToolCall["tool"], string> = {
  add_event: "Add calendar event",
  preclear_task: "Protect a task before a deadline",
  cancel_study: "Cancel study blocks",
  set_bucket_target: "Adjust weekly goal",
  move_block: "Move a study block",
  set_estimate: "Adjust task estimate",
  set_load: "Adjust task effort",
  mark_done: "Mark task complete",
  ask_canvas: "Check Canvas",
  timer: "Control focus timer",
  draft_email: "Draft an email",
  check_in: "Log a check-in",
  keep_block: "Pin a study block",
  schedule_task: "Schedule a task",
  order_blocks: "Order study blocks",
  set_grade_target: "Set a grade target",
  set_schedule: "Change routine settings",
  set_goal_days: "Choose days for a weekly goal",
  days_off: "Mark days with no school",
  add_task: "Save a dated milestone",
  remove_block: "Remove a study block",
  add_exam: "Add an exam",
  set_weekly_focus: "Set this week's focus",
  clear_day: "Clear a whole day",
  set_priority: "Change task priority",
  explain_plan: "Explain the plan",
};

/** Fingerprint of everything the planner reads. Plans are rebuilt whenever it changes. */
export function planKey(st: State): string {
  const pianoTaskIds = new Set(st.tasks.filter(isPianoItem).map((t) => t.id));
  const parts = JSON.stringify([
    st.tasks.filter((t) => !isPianoItem(t)).map((t) => [t.id, t.status, t.due_at, t.estimated_minutes, t.human_minutes, t.cognitive_load, t.preclear_by, t.course]),
    st.events.filter((e) => !isPianoItem(e)).map((e) => [e.id, e.kind, e.start, e.end]),
    st.buckets.map((b) => [b.key, b.target_hours, b.logged_minutes, b.load]),
    st.rules,
    st.blocks.filter((b) => !isPianoItem(b) && !(b.task_id && pianoTaskIds.has(b.task_id))
      && (b.locked || b.status !== "planned")).map((b) => [b.id, b.start, b.end, b.status, b.locked]),
    st.momentum?.mode,
    (st.grades ?? []).filter((g) => !/\bpiano\b/i.test(g.course))
      .map((g) => [g.course, g.score, g.target, g.ignore, g.history[0]?.date, g.history[g.history.length - 1]?.date]),
  ]);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < parts.length; i++) { h ^= parts.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** A reply that says a change happened (\"I've moved…\", \"Updated your…\"). */
const CLAIMS_CHANGE = /\b(i'?ve|i have|i)\s+(moved|removed|cleared|updated|changed|set|added|adjusted|rescheduled|blocked|scheduled)\b|^(updated|moved|removed|cleared|changed|set|added|done)\b/i;

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
    const eventDays = new Set(st.events.filter((e) => e.kind === "event" && !isPianoItem(e)).map((e) => e.start.slice(0, 10)));
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
    const pianoTaskIds = new Set(st.tasks.filter(isPianoItem).map((t) => t.id));
    const isPianoBlock = (b: Block) => !!b.task_id && pianoTaskIds.has(b.task_id);
    const pianoBlocks = st.blocks.filter(isPianoBlock);
    st.blocks = st.blocks.filter((b) => !isPianoBlock(b));
    if (st.timer.state !== "idle" && st.timer.block_id) { // keep the block being worked on in place
      const running = st.blocks.find((b) => b.id === st.timer.block_id);
      if (running) running.locked = true;
    }
    const { missed } = reconcile(st, now);
    const res = plan(st, now, { pace: this.pace(st), newId: uid, adjust: ADJUST[st.momentum!.mode] });
    st.blocks = [...pianoBlocks, ...res.blocks.filter((b) => parseLocal(b.start) > addDays(startOfDay(now), -14))]; // trim old history
    st.meta.at_risk = res.atRisk;
    st.meta.needs_replan = false;
    st.meta.plan_key = planKey(st);
    return { missed };
  }

  replan(): void { this.store.update((st) => { this.replanInto(st); }); }

  async estimateMissing(): Promise<number> {
    const todo = this.state.tasks.filter((t) => t.status === "open" && !isPianoItem(t) && !t.estimated_minutes);
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
      // A failed refinement must never escape: the heuristic estimates above are already applied.
      try {
        const e = await this.llm.estimate(t, this.state.tasks, focusFor(focus, t.course));
        if (e.source === "llm") refined.push([t.id, e]);
      } catch { /* keep the heuristic estimate for this task */ }
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
    if (!t || isPianoItem(t)) return { placed: 0, short: 0 };
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
      const { key, task } = resolveTarget(q, st.buckets, st.tasks.filter((t) => t.status === "open" && !isPianoItem(t)));
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
  lastThinking = "";
  lastVia: "llm" | "rules" = "rules";
  lastReply = "";
  lastTrace: string[] = [];
  /** Snapshot taken before an AI turn so its changes can be undone in one click. */
  private undoSnapshot: { state: State; label: string } | null = null;

  /** Undo the last AI turn's changes. Returns the label of what was undone, or null. */
  undoLastAI(): string | null {
    if (!this.undoSnapshot) return null;
    const { state, label } = this.undoSnapshot;
    this.undoSnapshot = null;
    this.store.replace(state);
    return label;
  }

  get canUndoAI(): boolean { return this.undoSnapshot !== null; }

  async run(text: string): Promise<Reply[]> {
    const now = this.clock();
    this.llm.restoreHistory(this.state.ai_memory);
    const storedMemory = JSON.stringify(this.state.ai_memory ?? []);
    const { calls, reply, thinking, via } = await this.llm.command(text, this.state, now);
    this.lastThinking = thinking;
    this.lastVia = via;
    this.lastReply = reply.trim();
    const model = this.llm.status.modelLabel ?? this.llm.status.model ?? "AI";
    this.lastTrace = [
      `Request: ${text}`,
      `Decision source: ${via === "llm" ? model : "Built-in rules"}`,
    ];
    const memory = this.llm.chatHistory.slice(-16);
    if (JSON.stringify(memory) !== storedMemory) {
      this.store.update((st) => { st.ai_memory = memory; });
      await this.store.flush();
      this.lastTrace.push(this.store.status === "synced"
        ? "Persistent AI memory synced to the relay."
        : "Persistent AI memory is saved locally and will sync when the relay is available.");
    }
    const out: Reply[] = [];
    if (!calls.length) {
      this.lastTrace.push("No action tool was selected; no changes were made.");
      // never let a model's "Done, I updated…" stand when nothing actually ran
      if (this.llm.lastUnusable) {
        out.push({ tone: "warn", text: "The AI model gave an unusable answer, so nothing was changed. Try again. If it keeps happening, pick one specific model in Settings → Connections instead of the random free router." });
        return out;
      }
      if (via === "llm" && (this.llm.lastRejected > 0 || CLAIMS_CHANGE.test(reply))) {
        out.push({ tone: "warn", text: `Nothing was changed. ${this.llm.lastRejected > 0
          ? "The AI tried a change the app couldn't read."
          : "The AI answered without making a change."} Try again, or say it more directly (e.g. “AIME only on weekends”, “no studying on Sundays”, “school ends at 2:45 on Mondays”).` });
        return out;
      }
      out.push({ tone: "info", text: reply || "I didn't catch a change in that. Try “I have a banquet at 7 tonight”, “what's my grade in bio?”, or “start a focus session for AIME”." });
      return out;
    }
    // Snapshot before the first change so the whole AI turn can be undone as one step.
    const before = structuredClone(this.state);
    for (const c of calls) {
      this.lastTrace.push(`Action: ${TRACE_ACTIONS[c.tool]}`);
      const result = await this.apply(c, text, now);
      this.lastTrace.push(`Outcome: ${result.text}`);
      out.push(result);
    }
    if (calls.length) {
      this.undoSnapshot = { state: before, label: calls.map((c) => TRACE_ACTIONS[c.tool]).join(", ") };
      this.lastTrace.push("Undo is available for this change.");
    }
    // the model's own words only when something it asked for actually worked
    if (reply && via === "llm" && (out.some((o) => o.tone !== "warn") || !CLAIMS_CHANGE.test(reply))) {
      out.unshift({ tone: "info", text: reply });
    }
    return out;
  }

  async clearChatMemory(): Promise<boolean> {
    this.llm.clearHistory();
    this.store.update((st) => { st.ai_memory = []; });
    await this.store.flush();
    return this.store.status === "synced";
  }

  async apply(c: ToolCall, original: string, now: Date): Promise<Reply> {
    const a = c.args as Record<string, string>;
    const st = this.state;
    const findTask = (q: string) => matchTasks(q, st.tasks.filter((t) => t.status === "open" && !isPianoItem(t)))[0];
    switch (c.tool) {
      case "add_task": {
        const title = String(a.title).trim();
        const course = typeof a.course === "string" && a.course.trim() ? a.course.trim() : "College Planning";
        const dueDate = String(a.due_date);
        const dueAt = `${dueDate}T23:59`;
        if (parseLocal(dueAt) < now) return { tone: "warn", text: `That milestone date (${dueDate}) has already passed, so I didn't add it.` };
        const rawEstimate = c.args.estimated_minutes;
        const estimate = rawEstimate == null || rawEstimate === "" ? 45 : Number(rawEstimate);
        if (!Number.isInteger(estimate) || estimate < 5 || estimate > 1200)
          return { tone: "warn", text: "Milestone estimate must be between 5 and 1,200 minutes; nothing was added." };
        const description = typeof a.description === "string" ? a.description.trim().slice(0, 500) : undefined;
        const duplicate = (t: Task) => t.status === "open"
          && t.course.toLowerCase() === course.toLowerCase()
          && t.title.toLowerCase() === title.toLowerCase()
          && t.due_at?.slice(0, 10) === dueDate;
        if (st.tasks.some(duplicate)) return { tone: "info", text: `“${title}” is already tracked for ${dueDate}.` };
        const milestone: Task = {
          id: uid(), source: "assistant", course, title, description, category: "project", task_type: "Project",
          due_at: dueAt, cognitive_load: 3, llm_minutes: estimate, estimated_minutes: estimate, human_minutes: null,
          confidence: 0.6, recommended_45m_blocks: splitChunks(estimate, st.rules.block_min, st.rules.min_block_min),
          est_source: "heuristic", logged_minutes: 0, status: "open",
        };
        let added = false;
        this.store.update((s) => {
          if (s.tasks.some(duplicate)) return;
          s.tasks.push(milestone);
          added = true;
          this.replanInto(s, now);
        });
        return added
          ? { tone: "ok", text: `Saved “${title}” in ${course} for ${dueDate}. Far-future milestones stay in Tasks and enter the Week plan as the date approaches.` }
          : { tone: "info", text: `“${title}” is already tracked for ${dueDate}.` };
      }
      case "add_event": {
        if (isPianoItem({ title: String(a.title) })) return { tone: "info", text: "Ignored the Piano event as requested; it won't affect your study plan." };
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
      case "days_off": {
        const dates = [...new Set((a.dates as unknown as string[]))].sort();
        const away = String(a.away) === "true";
        const title = typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 60) : away ? "Away" : "No school";
        const cut = fmtDate(addDays(startOfDay(now), -30));
        this.store.update((s) => {
          s.rules.no_school_dates = [...new Set([...(s.rules.no_school_dates ?? []).filter((d) => d >= cut), ...dates])].sort();
          if (away) for (const d of dates) {
            if (!s.events.some((e) => !e.deleted_at && e.kind === "blackout" && e.title === title && e.start === `${d}T00:00`))
              s.events.push({ id: uid(), title, kind: "blackout", start: `${d}T00:00`, end: `${d}T23:59` });
          }
          this.replanInto(s, now);
        });
        const fmt = (d: string) => new Date(`${d}T12:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        return { tone: "ok", text: `No school on ${dates.map(fmt).join(", ")}${away ? `, and no study (${title})` : ""}. Your weekly routine is unchanged; the plan was rebuilt.` };
      }
      case "set_goal_days": {
        const key = resolveBucket(String(a.bucket), st.buckets);
        if (!key || key === SCHOOL) return { tone: "warn", text: `There's no goal called ${a.bucket}.` };
        const days = [...new Set((a.days as unknown as number[]).map(Number))].sort((x, y) => x - y);
        this.store.update((s) => {
          const g = { ...(s.rules.goal_days ?? {}) };
          if (days.length && days.length < 7) g[key] = days; else delete g[key];
          s.rules.goal_days = g;
          this.replanInto(s, now);
        });
        const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        return { tone: "ok", text: days.length && days.length < 7
          ? `${key} now goes only on ${days.map((d) => names[d]).join(", ")}. The week was re-planned.`
          : `${key} can go on any day again. The week was re-planned.` };
      }
      case "set_schedule": {
        const patch = validateSchedulePatch(c.args);
        if (!patch) return { tone: "warn", text: "I couldn't apply those routine settings. Check the times, days and limits, then try again." };
        const next = { ...st.rules, ...patch };
        const schoolEnds = next.school_days.map((day) => next.school_end_by_day?.[String(day)] ?? next.school_end);
        if (schoolEnds.some((end) => end <= next.school_start)) {
          return { tone: "warn", text: "School dismissal must be later than the school start time. Your schedule was not changed." };
        }
        if (schoolEnds.some((end) => end >= next.sleep_cutoff) || next.dinner_start >= next.sleep_cutoff) {
          return { tone: "warn", text: "Your sleep cutoff must be later than school dismissal and dinner. Your schedule was not changed." };
        }
        this.store.update((s) => {
          Object.assign(s.rules, patch);
          this.replanInto(s, now);
        });
        const changes = Object.entries(patch).map(([key, value]) =>
          `${key.replace(/_/g, " ")}: ${Array.isArray(value) ? value.join(", ") : JSON.stringify(value)}`).join("; ");
        return { tone: "ok", text: `Updated your routine (${changes}) and rebuilt the study plan around it.` };
      }
      case "move_block": {
        const { key, task } = resolveTarget(String(a.target), st.buckets, st.tasks.filter((t) => t.status === "open" && !isPianoItem(t)));
        if (!key && !task) return { tone: "warn", text: `I couldn't match “${a.target}” to a task or weekly goal, so nothing was changed.` };
        const fromDate = typeof a.from_date === "string" ? a.from_date : null;
        const source = st.blocks
          .filter((b) => b.status === "planned" && parseLocal(b.start) > now
            && (fromDate == null || b.date === fromDate)
            && (key ? b.kind === "bucket" && b.bucket === key : b.task_id === task!.id))
          .sort((a, b) => a.start.localeCompare(b.start))[0];
        if (!source) return { tone: "warn", text: `I couldn't find a planned ${key ?? task!.title} block${fromDate ? ` on ${fromDate}` : ""} in the calendar, so nothing was changed.` };
        const fromDay = source.date;
        const ranges: Record<string, [string, string]> = { morning: ["06:00", "12:00"], afternoon: ["12:00", "18:30"], evening: ["18:30", "23:59"] };
        const [ws, we] = ranges[a.window as string] ?? ranges.afternoon;
        const day = parseLocal(`${a.to_date}T00:00`);
        // the whole sitting moves: same subject, back to back (only breaks between) on that day
        const same = (b: Block) => b.status === "planned" && b.date === source.date && (key ? b.kind === "bucket" && b.bucket === key : b.task_id === task!.id);
        const run: Block[] = [source];
        for (const b of st.blocks.filter((x) => same(x) && x.start > source.start).sort((x, y) => x.start.localeCompare(y.start))) {
          const gap = (parseLocal(b.start).getTime() - parseLocal(run[run.length - 1].end).getTime()) / 60000;
          if (gap < 0 || gap > Math.max(st.rules.break_min, 15) + 10) break;
          run.push(b);
        }
        const ids = new Set(run.map((b) => b.id));
        const t0 = parseLocal(source.start).getTime();
        const busy = st.blocks.filter((b) => !ids.has(b.id) && b.date === a.to_date && (b.locked || b.status === "done"))
          .map((b) => [parseLocal(b.start), parseLocal(b.end)] as [Date, Date]);
        const len = Math.round((parseLocal(run[run.length - 1].end).getTime() - t0) / 60000);
        const slot = freeIntervals(st.rules, day, st.events, busy, now).find((iv) => {
          const s = Math.max(iv.s.getHours() * 60 + iv.s.getMinutes(), hm(ws));
          const e = Math.min(iv.e.getHours() * 60 + iv.e.getMinutes(), hm(we));
          return e - s >= len;
        });
        if (!slot) return { tone: "warn", text: `No free ${len}-minute slot that ${a.window ?? "afternoon"} on ${a.to_date}.` };
        const sMin = Math.max(slot.s.getHours() * 60 + slot.s.getMinutes(), hm(ws));
        const s0 = new Date(day.getTime() + sMin * 60000), e0 = new Date(s0.getTime() + len * 60000);
        let moved = false;
        void e0;
        this.store.update((s) => {
          for (const r of run) {
            const block = s.blocks.find((b) => b.id === r.id && b.status === "planned");
            if (!block) continue;
            const off = parseLocal(r.start).getTime() - t0, dur = parseLocal(r.end).getTime() - parseLocal(r.start).getTime();
            const bs = new Date(s0.getTime() + off);
            Object.assign(block, { date: a.to_date, start: fmtLocal(bs), end: fmtLocal(new Date(bs.getTime() + dur)), locked: true });
            moved = true;
          }
          if (moved) this.replanInto(s, now);
        });
        if (!moved) return { tone: "warn", text: `That calendar block changed before I could move it; nothing was changed.` };
        const what = run.length > 1 ? `${source.title} (${run.length} blocks, ${hm12(fmtLocal(s0))}–${hm12(fmtLocal(new Date(s0.getTime() + len * 60000)))})` : source.title;
        return { tone: "ok", text: `Moved ${what} from ${fromDay} to ${a.to_date} at ${hm12(fmtLocal(s0))}.` };
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
        if (/\bpiano\b/i.test(String(a.course))) return { tone: "info", text: "Piano isn't part of school-grade planning, so I left it unchanged." };
        const r = this.setGradeTarget(String(a.course), a.target == null ? null : Number(a.target));
        return { tone: r.ok ? "ok" : "warn", text: r.text };
      }
      case "keep_block": {
        const { key, task } = resolveTarget(String(a.target), st.buckets, st.tasks.filter((t) => t.status === "open" && !isPianoItem(t)));
        if (!key && !task) return { tone: "warn", text: `I couldn't find “${a.target}” in your plan.` };
        const hit = (b: Block) => b.status === "planned" && (a.date ? b.date === a.date : parseLocal(b.end) > now)
          && (key ? b.bucket === key && b.kind === "bucket" : b.task_id === task!.id);
        const ids = st.blocks.filter(hit).sort((x, y) => x.start.localeCompare(y.start)).slice(0, a.date ? 9 : 1).map((b) => b.id);
        if (!ids.length) return { tone: "warn", text: `${key ?? task!.title} has no upcoming block to keep${a.date ? ` on ${a.date}` : ""}.` };
        // Locking only pins a block that is already in the plan, so no replan is needed here.
        // Replanning would regenerate every other block and destroy the target of a follow-up
        // move in the same AI turn (e.g. "keep AIME but move research"). Updating plan_key keeps
        // the store's afterMutate hook from replanning for this lock-only change.
        this.store.update((s) => {
          for (const b of s.blocks) if (ids.includes(b.id)) b.locked = true;
          s.meta.plan_key = planKey(s);
        });
        const first = this.state.blocks.find((b) => b.id === ids[0]);
        return { tone: "ok", text: `Kept ${key ?? task!.title}${first ? ` at ${hm12(first.start)} on ${first.date}` : ""}. Everything else can still shift around it.` };
      }
      case "remove_block": {
        const { key, task } = resolveTarget(String(a.target), st.buckets, st.tasks.filter((t) => t.status === "open" && !isPianoItem(t)));
        if (!key && !task) return { tone: "warn", text: `I couldn't match “${a.target}” to a task or weekly goal, so nothing was removed.` };
        const date = typeof a.date === "string" ? a.date : null;
        const hit = (b: Block) => b.status === "planned" && parseLocal(b.end) > now
          && (date == null || b.date === date)
          && (key ? b.kind === "bucket" && b.bucket === key : b.task_id === task!.id);
        const doomed = st.blocks.filter(hit).sort((x, y) => x.start.localeCompare(y.start));
        if (!doomed.length) return { tone: "warn", text: `There's no upcoming ${key ?? task!.title} block${date ? ` on ${date}` : ""} to remove.` };
        const target = doomed[0];
        this.store.update((s) => {
          s.blocks = s.blocks.filter((b) => b.id !== target.id);
          // blackout the freed slot so the planner doesn't immediately put the same work back there
          s.events.push({ id: uid(), title: "Removed block", kind: "blackout", start: target.start, end: target.end });
          this.replanInto(s, now);
        });
        return { tone: "ok", text: `Removed the ${key ?? task!.title} block at ${hm12(target.start)} on ${target.date}. The rest re-planned around it.` };
      }
      case "add_exam": {
        const course = String(a.course).trim();
        const date = String(a.date);
        const start = typeof a.start === "string" && a.start ? a.start : "08:00";
        const end = fmtLocal(new Date(parseLocal(`${date}T${start}`).getTime() + 2 * 3600000)).slice(11);
        const weight = a.weight == null ? null : Number(a.weight);
        const units = Array.isArray(a.units) ? a.units.map((u) => String(u)).filter(Boolean) : [];
        const title = weight != null ? `${course} exam (${weight}% of grade)` : `${course} exam`;
        this.store.update((s) => {
          s.events.push({ id: uid(), title, kind: "event", start: `${date}T${start}`, end: `${date}T${end}` });
          // An exam is a hard deadline: pull any open work in that course ahead of it.
          for (const t of s.tasks) {
            if (t.status !== "open" || t.course.toLowerCase() !== course.toLowerCase()) continue;
            if (t.due_at && parseLocal(t.due_at) > parseLocal(`${date}T${start}`)) t.preclear_by = `${date}T${start}`;
          }
          this.replanInto(s, now);
        });
        const detail = [weight != null ? `${weight}% of your grade` : null, units.length ? units.join(", ") : null]
          .filter(Boolean).join(" · ");
        return { tone: "ok", text: `Added ${course} exam on ${date} at ${hm12(`${date}T${start}`)}${detail ? ` (${detail})` : ""}. Work in that course now lands before it.` };
      }
      case "set_weekly_focus": {
        const focus = String(a.focus).trim();
        this.store.update((s) => { s.rules.weekly_focus = focus; this.replanInto(s, now); });
        return { tone: "ok", text: `This week's focus is “${focus}”. I'll protect time for it first.` };
      }
      case "clear_day": {
        const date = String(a.date);
        const doomed = st.blocks.filter((b) => b.date === date && b.status === "planned");
        if (!doomed.length) return { tone: "warn", text: `There's nothing planned on ${date} to clear.` };
        this.store.update((s) => {
          s.blocks = s.blocks.filter((b) => !(b.date === date && b.status === "planned"));
          s.events.push({ id: uid(), title: "Day cleared", kind: "blackout", start: `${date}T00:00`, end: `${date}T23:59` });
          this.replanInto(s, now);
        });
        return { tone: "ok", text: `Cleared ${doomed.length} block${doomed.length > 1 ? "s" : ""} on ${date}. The day is free.` };
      }
      case "set_priority": {
        const t = findTask(String(a.task_query));
        if (!t) return { tone: "warn", text: `I couldn't find a task matching “${a.task_query}”.` };
        const priority = String(a.priority) as "high" | "normal" | "low";
        this.store.update((s) => {
          const x = s.tasks.find((y) => y.id === t.id)!;
          if (priority === "normal") delete x.priority;
          else x.priority = priority;
          this.replanInto(s, now);
        });
        const why = priority === "high" ? "It'll be pulled forward ahead of other work."
          : priority === "low" ? "It'll yield to everything else." : "It's back to normal priority.";
        return { tone: "ok", text: `${t.title} is now ${priority === "normal" ? "normal" : priority} priority. ${why}` };
      }
      case "explain_plan": {
        const date = typeof a.date === "string" ? a.date : fmtDate(now);
        const dayBlocks = st.blocks.filter((b) => b.date === date && b.status !== "done").slice(0, 6);
        const risk = st.meta.at_risk.length;
        const focus = st.rules.weekly_focus;
        const parts: string[] = [];
        if (focus) parts.push(`This week's focus is “${focus}”, so that gets the best slots.`);
        if (dayBlocks.length) {
          parts.push(`On ${date} you have ${dayBlocks.map((b) => `${b.title} (${hm12(b.start)})`).join(", ")}.`);
        } else parts.push(`Nothing is planned on ${date}.`);
        if (risk) parts.push(`${risk} item${risk > 1 ? "s are" : " is"} at risk because there isn't enough free time before the deadline — sleep and buffers are protected, so something has to give.`);
        else parts.push("Everything fits before its deadline with sleep and buffers protected.");
        return { tone: "info", text: parts.join(" ") };
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
