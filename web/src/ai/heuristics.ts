// Fallbacks used when WebGPU or the 3B model is unavailable: a workload estimator and a
// rule-based command parser that emits the same tool calls the LLM is asked for.

import { targetFrom } from "../core/grades";
import type { Bucket, Category, Rules, Task, TaskType } from "../core/types";
import { addDays, fmtDate } from "../core/time";
import { splitChunks } from "../core/schedule";

export const TASK_TYPE: Record<Category, TaskType> = { homework: "HW", quiz: "Quiz", test: "Exam", project: "Project", lab: "Lab" };
const BASE_MIN: Record<Category, number> = { homework: 35, quiz: 40, test: 120, project: 150, lab: 75 };
const BASE_LOAD: Record<Category, number> = { homework: 3, quiz: 3, test: 5, project: 4, lab: 3 };
const QUANT = ["math", "calculus", "physics", "chemistry", "statistics", "precalc", "algebra"];
const COURSE_FACTOR: [string, number][] = [["physics", 1.25], ["calculus", 1.2], ["chemistry", 1.15], ["english", 1.1], ["history", 1.05], ["spanish", 0.9]];

export interface Estimate { task_type: TaskType; cognitive_load: number; minutes: number; confidence: number; source: "llm" | "heuristic"; why?: string }

/** Concrete workload facts pulled out of a Canvas title + directions + comments (problem counts, words, pages, report parts). */
export function workSignals(t: Pick<Task, "title" | "description" | "comments" | "points">): string[] {
  const text = `${t.title} ${t.description ?? ""} ${(t.comments ?? []).join(" ")}`.toLowerCase();
  const out: string[] = [];
  const m = text.match(/(?:problems?|#|exercises?|questions?)\s*(\d+)\s*[-–]\s*(\d+)/);
  if (m) {
    let n = Math.max(1, Number(m[2]) - Number(m[1]) + 1);
    const half = /\b(odd|even)\b/.test(text);
    if (half) n = Math.ceil(n / 2);
    out.push(`${n} problems${half ? " (odds/evens)" : ""}`);
  } else {
    const q = text.match(/\b(\d{1,3})\s+(?:problems|questions|exercises)\b/);
    if (q) out.push(`${q[1]} problems`);
  }
  const w = text.match(/(\d{3,4})\s*(?:[-–]\s*(\d{3,4}))?\s*words?/);
  if (w) out.push(`${w[2] ? `${w[1]}-${w[2]}` : w[1]} words`);
  const p = text.match(/(?:pp?\.?|pages?)\s*(\d+)\s*[-–]\s*(\d+)/);
  if (p) out.push(`${Number(p[2]) - Number(p[1]) + 1} pages`);
  const ch = text.match(/\bchapters?\s*(\d+)\s*[-–]\s*(\d+)/);
  if (ch) out.push(`${Number(ch[2]) - Number(ch[1]) + 1} chapters`);
  const timed = text.match(/(\d{2,3})\s*(?:-| )?min(?:ute)?s?\b.*\b(?:timed|time limit)|\b(?:timed|time limit)\D{0,20}(\d{2,3})\s*min/);
  if (timed) out.push(`timed ${timed[1] ?? timed[2]} min`);
  const tags: [RegExp, string][] = [
    [/\b(error analysis|uncertainty)\b/, "error analysis"], [/\blab report\b/, "lab report"], [/\brubric\b/, "has a rubric"],
    [/\b(presentation|slides|present)\b/, "presentation"], [/\b(video|record)\b/, "video"], [/\b(group|partner)s?\b/, "group work"],
    [/\b(annotat\w*)\b/, "annotations"], [/\b(outline|draft)\b/, "draft"], [/\b(cit\w+|mla|apa|works cited|sources)\b/, "citations"],
    [/\b(study guide|review sheet)\b/, "study guide"], [/\bcalculator inactive|no calculator\b/, "no calculator"],
  ];
  for (const [re, tag] of tags) if (re.test(text)) out.push(tag);
  const sub = (t.description ?? "").match(/Submit: ([^\n]+)/);
  if (sub) out.push(`submit ${sub[1]}`);
  return [...new Set(out)].slice(0, 6);
}

export function heuristicEstimate(t: Pick<Task, "category" | "course" | "title" | "description" | "comments" | "points">): Estimate {
  const cat = t.category;
  const course = (t.course || "").toLowerCase();
  const text = `${t.title} ${t.description ?? ""} ${(t.comments ?? []).join(" ")}`.toLowerCase();
  const quant = QUANT.some((q) => course.includes(q));
  let minutes = BASE_MIN[cat] ?? 40;
  const m = text.match(/(?:problems?|#|exercises?)\s*(\d+)\s*[-–]\s*(\d+)/) ?? text.match(/\b\d+\.(\d+)\s*[-–]\s*\d+\.(\d+)\b/);
  if (m && cat === "homework") {
    let n = Math.max(1, Number(m[2]) - Number(m[1]) + 1);
    if (/\b(odd|even)\b/.test(text)) n = Math.ceil(n / 2);
    minutes = n * (quant ? 3 : 2);
  }
  const words = text.match(/(\d{3,4})\s*(?:[-–]\s*(\d{3,4}))?\s*words?/);
  if (words) minutes = Math.max(minutes, Number(words[2] ?? words[1]) / 9);
  const pages = text.match(/pp?\.?\s*(\d+)\s*[-–]\s*(\d+)/);
  if (pages && cat === "homework") minutes = Math.max(minutes, (Number(pages[2]) - Number(pages[1]) + 1) * 9);
  if (/\b(read|reading|annotate)\b/.test(text)) minutes += 10;
  if (/\b(error analysis|uncertainty|full lab report)\b/.test(text)) minutes += 20;
  if (t.points) minutes *= Math.min(1.5, Math.max(0.8, 1 + 0.25 * Math.log10(Math.max(t.points, 1) / 10)));
  minutes *= COURSE_FACTOR.find(([k]) => course.includes(k))?.[1] ?? 1;
  let load = BASE_LOAD[cat] ?? 3;
  if ((cat === "homework" || cat === "quiz") && quant) load++;
  if (course.includes("spanish")) load--;
  const conf = 0.45 + ((t.description ?? "").length > 60 ? 0.1 : 0) + ((t.comments?.length ?? 0) > 0 ? 0.05 : 0) + (t.points ? 0.1 : 0) + (m || words ? 0.05 : 0);
  const sig = workSignals(t);
  return { task_type: TASK_TYPE[cat] ?? "HW", cognitive_load: Math.max(1, Math.min(5, load)),
    minutes: Math.max(10, Math.round(minutes / 5) * 5), confidence: Math.round(Math.min(conf, 0.7) * 100) / 100, source: "heuristic",
    why: sig.length ? sig.join(" · ") : `typical ${cat}${t.points ? `, ${t.points} pts` : ""}` };
}

export function applyEstimate(t: Task, e: Estimate, blockMin = 45, minBlock = 20): Task {
  t.task_type = e.task_type;
  t.cognitive_load = e.cognitive_load;
  t.llm_minutes = e.minutes;
  t.estimated_minutes = e.minutes;
  t.confidence = e.confidence;
  t.est_source = t.human_minutes != null ? "human" : e.source;
  if (e.why) t.est_why = e.why.slice(0, 120);
  t.recommended_45m_blocks = splitChunks(t.human_minutes ?? e.minutes, blockMin, minBlock);
  return t;
}

// ------------------------------------------------------------------ commands
export type ToolName = "add_event" | "preclear_task" | "cancel_study" | "set_bucket_target" | "move_block"
  | "set_estimate" | "set_load" | "mark_done" | "ask_canvas" | "timer" | "draft_email" | "check_in" | "keep_block"
  | "schedule_task" | "order_blocks" | "set_grade_target" | "set_schedule" | "set_goal_days" | "days_off" | "add_task" | "remove_block"
  | "add_exam" | "set_weekly_focus" | "clear_day" | "set_priority" | "explain_plan";
export interface ToolCall { tool: ToolName; args: Record<string, unknown> }

export const TOOL_SPECS: Record<ToolName, string> = {
  add_event: "title:string, date:YYYY-MM-DD, start:HH:MM, end:HH:MM|null — scheduled event (banquet, practice, concert, meeting); pre-clears Tier 1 work due by tomorrow",
  preclear_task: "task_query:string, date:YYYY-MM-DD, before:HH:MM",
  cancel_study: "date:YYYY-MM-DD, after:HH:MM|null — drop study blocks until the sleep cutoff",
  set_bucket_target: "bucket:AIME|USAAIO|RESEARCH|ACT|PHYSICS|SELF, hours:number",
  move_block: "target:string (bucket key or task words), from_date:YYYY-MM-DD|null, to_date:YYYY-MM-DD, window:morning|afternoon|evening — move an existing calendar block; the rest re-plans itself",
  schedule_task: "task_query:string, date:YYYY-MM-DD, window:morning|afternoon|evening|null — put ALL remaining work for one assignment on that day (\"do the essay on Saturday\")",
  order_blocks: "first:string, then:string, date:YYYY-MM-DD|null — reorder two blocks on a day so `first` comes before `then` (\"chem before calc tonight\")",
  set_grade_target: "course:string, target:number(percent)|null — the grade the student wants in a class; the planner gives below-goal classes more time and weekly review (\"I want an A in chem\", \"get precalc to 95\")",
  set_schedule: "one or more of school_days:number[] (1=Mon..7=Sun), school_start:HH:MM, school_end:HH:MM, school_end_by_day:object{weekday:HH:MM}, commute_min:number, after_school_min:number, dinner_start:HH:MM, dinner_min:number, sleep_cutoff:HH:MM, weekend_start:HH:MM, block_min:number, break_min:number, min_block_min:number, preclear_hours:number, event_prep_min:number, rest_days:number[], quiet_weekday:string[], quiet_weekend:string[], quiet_by_day:object{weekday:string[]} — change only explicitly requested settings; preserve the rest and re-plan",
  days_off: "dates:YYYY-MM-DD[], away:boolean, title:string|null — one-off days with NO SCHOOL (\"no school today\", \"no school this week\", sick day, break); away=true also keeps those days free of study (trip: \"skiing Thu-Sat\"). Never use set_schedule school_days for a one-off day",
  set_goal_days: "bucket:AIME|USAAIO|RESEARCH|ACT|PHYSICS|SELF, days:number[] (1=Mon..7=Sun; [] = any day) — which weekdays a weekly goal may be studied (\"AIME on weekends only\" -> [6,7], \"no ACT on school nights\")",
  add_task: "title:string, due_date:YYYY-MM-DD, description:string|null, estimated_minutes:int|null, course:string|null — save a dated milestone; use College Planning for college milestones",
  keep_block: "target:string (bucket key or task words), date:YYYY-MM-DD|null — pin it where it is so re-planning never moves it (\"keep\", \"don't move\", \"leave\")",
  remove_block: "target:string (bucket key or task words), date:YYYY-MM-DD|null — delete ONE specific study block from the calendar (\"remove my AIME block\", \"drop the research session tonight\"); the rest re-plans around it",
  set_estimate: "task_query:string, minutes:int",
  set_load: "task_query:string, cognitive_load:1-5",
  mark_done: "task_query:string",
  ask_canvas: "what:grades|assignments|announcements|modules|syllabus, course:string|null, search:string|null — read the student's Canvas classes",
  timer: "action:start|pause|resume|stop, target:string|null (bucket key or task words)",
  draft_email: "to:string (email or who, e.g. 'counselor'), subject:string, body:string, reason:string — creates a draft the student reviews; never sends",
  check_in: "mood:1-5 (1 rough .. 5 great) — the student said how they feel",
  add_exam: "course:string, date:YYYY-MM-DD, start:HH:MM|null, weight:number|null (percent of grade), units:string[]|null — a graded exam or test; the planner builds a study ramp before it and treats it as a hard deadline",
  set_weekly_focus: "focus:string — the one thing that matters most this week ('this week is all about the AIME'); the planner protects time for it and mentions it in check-ins",
  clear_day: "date:YYYY-MM-DD — wipe every study block on that day ('clear my whole Tuesday')",
  set_priority: "task_query:string, priority:high|normal|low — how much a task matters; high pulls work forward, low yields to everything else",
  explain_plan: "date:YYYY-MM-DD|null — explain why the plan looks the way it does; use when the student asks why, how come, or wants the reasoning",
};

export type SchedulePatch = Partial<Pick<Rules,
  "school_days" | "rest_days" | "school_start" | "school_end" | "school_end_by_day" | "commute_min" |
  "after_school_min" | "dinner_start" | "dinner_min" | "sleep_cutoff" | "weekend_start" |
  "block_min" | "break_min" | "min_block_min" | "preclear_hours" | "event_prep_min" |
  "quiet_weekday" | "quiet_weekend" | "quiet_by_day">>;

const TIME_SETTINGS = ["school_start", "school_end", "dinner_start", "sleep_cutoff", "weekend_start"] as const;
const MINUTE_SETTINGS = {
  commute_min: [0, 180],
  after_school_min: [0, 240],
  dinner_min: [15, 240],
  block_min: [20, 180],
  break_min: [0, 90],
  min_block_min: [10, 120],
  preclear_hours: [0, 168],
  event_prep_min: [0, 240],
} as const;

/** Validate a partial routine update without changing any settings the user left out. */
const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** 1=Mon..7=Sun from a number, "3", "Wed", "wednesday", "Weds", "Thurs"…; null if it isn't a weekday. */
export function dayNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= 7 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (/^[1-7]$/.test(t)) return Number(t);
  const i = DAY_NAMES.findIndex((d) => t.startsWith(d) || (d === "thu" && /^th(u|ur|urs)?$/.test(t)) || (d === "tue" && t === "tues"));
  return i >= 0 && /^[a-z]+$/.test(t) && t.length <= 9 ? i + 1 : null;
}
/** Weekday lists and weekday-keyed objects in model output -> ISO numbers ("Mon" -> 1, "Sunday" -> 7). */
export function normalizeDays(args: Record<string, unknown>, listKeys: string[], objectKeys: string[]): void {
  for (const k of listKeys) if (Array.isArray(args[k])) {
    const nums = (args[k] as unknown[]).map(dayNum);
    if (nums.every((n) => n !== null)) args[k] = [...new Set(nums as number[])];
  }
  for (const k of objectKeys) {
    const o = args[k];
    if (typeof o !== "object" || o === null || Array.isArray(o)) continue;
    const out: Record<string, unknown> = {};
    for (const [day, val] of Object.entries(o)) {
      const n = dayNum(day);
      if (n === null) return; // leave it for the validator to reject
      out[String(n)] = val;
    }
    args[k] = out;
  }
}

export function validateSchedulePatch(value: unknown): SchedulePatch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const allowed = new Set<string>([
    ...TIME_SETTINGS, ...Object.keys(MINUTE_SETTINGS), "school_days", "rest_days",
    "school_end_by_day", "quiet_weekday", "quiet_weekend", "quiet_by_day",
  ]);
  if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) return null;
  const patch: SchedulePatch = {};
  const validTime = (time: unknown) => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const validDays = (days: unknown): days is number[] => Array.isArray(days) &&
    days.length <= 7 && days.every((day) => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7) &&
    new Set(days).size === days.length;
  const validWindows = (windows: unknown): windows is string[] => Array.isArray(windows) && windows.length <= 6 &&
    windows.every((window) => {
      if (typeof window !== "string") return false;
      const match = window.match(/^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/);
      return !!match && match[1] < match[2];
    });

  for (const key of TIME_SETTINGS) {
    if (key in input) {
      if (!validTime(input[key])) return null;
      if (key === "school_start") {
        const time = input[key] as string;
        if (time < "05:00" || time > "12:00") return null;
        patch.school_start = time;
      } else if (key === "school_end") {
        const time = input[key] as string;
        if (time < "10:00" || time > "22:00") return null;
        patch.school_end = time;
      } else if (key === "dinner_start") {
        const time = input[key] as string;
        if (time < "16:00" || time > "22:00") return null;
        patch.dinner_start = time;
      } else if (key === "sleep_cutoff") {
        const time = input[key] as string;
        if (time < "18:00") return null;
        patch.sleep_cutoff = time;
      } else {
        const time = input[key] as string;
        if (time < "05:00" || time > "18:00") return null;
        patch.weekend_start = time;
      }
    }
  }
  for (const key of Object.keys(MINUTE_SETTINGS) as (keyof typeof MINUTE_SETTINGS)[]) {
    if (key in input) {
      const value = input[key];
      const [min, max] = MINUTE_SETTINGS[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
      patch[key] = value;
    }
  }
  if ("school_days" in input) {
    if (!validDays(input.school_days)) return null;
    patch.school_days = [...input.school_days].sort((a, b) => a - b);
  }
  if ("rest_days" in input) {
    if (!validDays(input.rest_days)) return null;
    patch.rest_days = [...input.rest_days].sort((a, b) => a - b);
  }
  if ("school_end_by_day" in input) {
    const overrides = input.school_end_by_day;
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return null;
    const clean: Record<string, string> = {};
    for (const [day, time] of Object.entries(overrides)) {
      if (!/^[1-7]$/.test(day) || !validTime(time)) return null;
      clean[day] = time;
    }
    patch.school_end_by_day = clean;
  }
  if ("quiet_weekday" in input) {
    if (!validWindows(input.quiet_weekday)) return null;
    patch.quiet_weekday = [...input.quiet_weekday];
  }
  if ("quiet_weekend" in input) {
    if (!validWindows(input.quiet_weekend)) return null;
    patch.quiet_weekend = [...input.quiet_weekend];
  }
  if ("quiet_by_day" in input) {
    const windowsByDay = input.quiet_by_day;
    if (typeof windowsByDay !== "object" || windowsByDay === null || Array.isArray(windowsByDay)) return null;
    const clean: Record<string, string[]> = {};
    for (const [day, windows] of Object.entries(windowsByDay)) {
      if (!/^[1-7]$/.test(day) || !validWindows(windows)) return null;
      clean[day] = [...windows];
    }
    patch.quiet_by_day = clean;
  }
  return patch;
}

export const BUCKET_ALIASES: Record<string, string[]> = {
  AIME: ["aime", "competition math", "comp math", "amc", "contest math"],
  USAAIO: ["usaaio", "usaio", "ai olympiad", "olympiad"],
  RESEARCH: ["research", "isef", "synopsys", "science fair"],
  ACT: ["act prep", "act"],
  PHYSICS: ["physics", "extra stem", "stem"],
  SELF: ["self improvement", "self-improvement", "personal growth", "self care", "self-care", "journaling", "journal",
    "meditation", "meditate", "mindfulness", "reflection", "reading for fun", "habit", "habits", "wellness", "therapy",
    "exercise", "workout", "gym", "running", "sleep routine", "skincare", "personal project"],
};
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const STOP = new Set(["my", "the", "a", "an", "for", "of", "to", "on", "in", "ap", "estimate", "as", "is", "task",
  "assignment", "minutes", "min", "instead", "please", "class"]);
const CATEGORY_WORDS: Record<string, Category> = { homework: "homework", hw: "homework", quiz: "quiz", test: "test",
  exam: "test", lab: "lab", project: "project", essay: "project", dbq: "project" };

export function parseTime(text: string, evening = false): string | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d.])/i);
  if (!m) return /\bnoon\b/i.test(text) ? "12:00" : null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0), mer = (m[3] ?? "").toLowerCase();
  if (h > 23 || mi > 59) return null;
  if (mer.startsWith("p") && h < 12) h += 12;
  else if (mer.startsWith("a") && h === 12) h = 0;
  else if (!mer && h < 12 && (h <= 7 || evening)) h += 12; // "before 5" on a school day = 5 PM
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export function parseDate(text: string, today: Date): string | null {
  const t = text.toLowerCase();
  if (/\b(tonight|today|this (evening|afternoon|morning))\b/.test(t)) return fmtDate(today);
  if (/\btomorrow\b/.test(t)) return fmtDate(addDays(today, 1));
  const m = t.match(new RegExp(`\\b(next\\s+)?(${WEEKDAYS.join("|")})\\b`));
  if (m) {
    let delta = (WEEKDAYS.indexOf(m[2]) - ((today.getDay() + 6) % 7) + 7) % 7;
    if (m[1] && delta === 0) delta = 7;
    return fmtDate(addDays(today, delta));
  }
  return t.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null;
}

const parseWindow = (t: string): string | null => {
  const m = t.toLowerCase().match(/\b(morning|afternoon|evening|night|tonight)\b/);
  return m ? ({ night: "evening", tonight: "evening" } as Record<string, string>)[m[1]] ?? m[1] : null;
};

export function resolveBucket(text: string, buckets: Pick<Bucket, "key" | "name">[]): string | null {
  const t = text.toLowerCase();
  for (const b of buckets) if (new RegExp(`\\b${b.key.toLowerCase()}\\b`).test(t)) return b.key;
  for (const [key, al] of Object.entries(BUCKET_ALIASES))
    if (buckets.some((b) => b.key === key) && al.some((a) => new RegExp(`\\b${a}\\b`).test(t))) return key;
  return null;
}

const tokens = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 1));

export function matchTasks<T extends Pick<Task, "course" | "title" | "category" | "status">>(query: string, tasks: T[]): T[] {
  const all = tokens(query);
  const hint = new Set([...all].filter((w) => w in CATEGORY_WORDS).map((w) => CATEGORY_WORDS[w]));
  const q = [...all].filter((w) => !(w in CATEGORY_WORDS) || w === "essay");
  const scored: [number, T][] = [];
  for (const t of tasks) {
    if (t.status !== "open") continue;
    const ct = tokens(t.course), tt = tokens(t.title);
    let s = 0;
    // "calc" → Calculus, "chem" → Chemistry, "lit" → Literature: a 3+ letter prefix counts
    const pre = (set: Set<string>, w: string) => w.length >= 3 && [...set].some((x) => x.length > w.length && x.startsWith(w));
    for (const w of q) s += ct.has(w) ? 2 : tt.has(w) ? 1 : pre(ct, w) ? 1.75 : pre(tt, w) ? 0.75 : 0;
    if (hint.has(t.category)) s += 1.5;
    if (s > 0) scored.push([s, t]);
  }
  if (!scored.length) return [];
  const best = Math.max(...scored.map(([s]) => s));
  return best >= 1 ? scored.filter(([s]) => s === best).map(([, t]) => t) : [];
}

export const splitClauses = (text: string): string[] =>
  text.trim().split(/[;,]\s*|\.\s+|\s+and\s+(?!a half\b)(?=[a-z])|\s+but\s+|\s+so\s+(?=(?:get|finish|pre-?clear|cancel|drop|skip|move|push|set|start|pause|mark)\b)|\s+then\s+|\s+also\s+/i).map((p) => p.replace(/^[\s.]+|[\s.]+$/g, "")).filter(Boolean);

/** Enhanced rule parsing for schedule editing - handles more natural language patterns */
export function parseScheduleEdit(text: string, now: Date, buckets: Pick<Bucket, "key" | "name">[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const ctxDate = parseDate(text, now) ?? fmtDate(now);
  const whole = text.toLowerCase().trim();
  
  // "keep X but move Y" - split into two calls
  const keepMoveMatch = whole.match(/\b(keep|don'?t move|do not move|lock|pin)\s+(?:my\s+)?(.+?)\s+(?:but|then)\s+(move|shift|push|reschedule)\s+(.+)$/i);
  if (keepMoveMatch) {
    const keepTarget = keepMoveMatch[2].replace(/\s+(?:block|session)\s*$/i, "").trim();
    const moveTarget = keepMoveMatch[4].replace(/\s+(?:block|session)\s*$/i, "").trim();
    const to = parseDate(keepMoveMatch[4], now) ?? parseDate(text, now);
    if (to) {
      calls.push({ tool: "keep_block", args: { target: TASK_WORDS.test(keepTarget) ? keepTarget : resolveBucket(keepTarget, buckets) ?? keepTarget, date: ctxDate } });
      const fromMatch = keepMoveMatch[4].match(/\bfrom\s+(.+)$/i);
      const cleanMoveTarget = fromMatch ? keepMoveMatch[4].slice(0, fromMatch.index).trim() : moveTarget;
      const fromDate = fromMatch ? parseDate(fromMatch[1], now) : null;
      calls.push({ tool: "move_block", args: {
        target: TASK_WORDS.test(cleanMoveTarget) ? cleanMoveTarget : resolveBucket(cleanMoveTarget, buckets) ?? cleanMoveTarget,
        ...(fromDate ? { from_date: fromDate } : {}),
        to_date: to,
        window: parseWindow(keepMoveMatch[4]) ?? "afternoon",
      } });
      return calls;
    }
  }
  
  // "move X to Y" patterns - only if it's a clear move command (not "don't move")
  // Must start with move/shift/push/reschedule, not "don't move"
  const moveMatch = whole.match(/^(?:move|shift|push|reschedule)\s+(?:my\s+)?(.+?)\s+to\s+(.+)$/i);
  if (moveMatch) {
    const target = moveMatch[1].replace(/\s+(?:block|session)\s*$/i, "").trim();
    const to = parseDate(moveMatch[2], now);
    if (to) {
      const fromMatch = moveMatch[1].match(/\bfrom\s+(.+)$/i);
      const cleanTarget = fromMatch ? moveMatch[1].slice(0, fromMatch.index).trim() : target;
      const fromDate = fromMatch ? parseDate(fromMatch[1], now) : null;
      calls.push({ tool: "move_block", args: {
        target: TASK_WORDS.test(cleanTarget) ? cleanTarget : resolveBucket(cleanTarget, buckets) ?? cleanTarget,
        ...(fromDate ? { from_date: fromDate } : {}),
        to_date: to,
        window: parseWindow(moveMatch[2]) ?? "afternoon",
      } });
      return calls;
    }
  }
  
  // "move X to Y" patterns in middle of sentence (after "and" or ",")
  const moveMatch2 = whole.match(/(?:^|[,;]\s*|\s+and\s+)(move|shift|push|reschedule)\s+(?:my\s+)?(.+?)\s+to\s+(.+)$/i);
  if (moveMatch2) {
    const target = moveMatch2[2].replace(/\s+(?:block|session)\s*$/i, "").trim();
    const to = parseDate(moveMatch2[3], now);
    if (to) {
      const fromMatch = moveMatch2[2].match(/\bfrom\s+(.+)$/i);
      const cleanTarget = fromMatch ? moveMatch2[2].slice(0, fromMatch.index).trim() : target;
      const fromDate = fromMatch ? parseDate(fromMatch[1], now) : null;
      calls.push({ tool: "move_block", args: {
        target: TASK_WORDS.test(cleanTarget) ? cleanTarget : resolveBucket(cleanTarget, buckets) ?? cleanTarget,
        ...(fromDate ? { from_date: fromDate } : {}),
        to_date: to,
        window: parseWindow(moveMatch2[3]) ?? "afternoon",
      } });
      return calls;
    }
  }
  
  return calls;
}

/** Words that mean an assignment, not a weekly goal ("the physics lab" is a task, "physics" is a goal). */
export const TASK_WORDS = /\b(lab|homework|hw|reading|essay|quiz|test|exam|problem set|pset|project|assignment|worksheet|draft|annotations?|report)\b/i;

/** What a block target names: a weekly goal or an assignment. A goal word inside a longer task title
 *  ("Email teacher re: True Self…") doesn't make it the Self goal: the goal wins only when the target
 *  is short or starts with the goal's name. */
export function resolveTarget<T extends Pick<Task, "course" | "title" | "category" | "status">>(
  q: string, buckets: Pick<Bucket, "key" | "name">[], tasks: T[]): { key: string | null; task: T | undefined } {
  const task = matchTasks(q, tasks)[0];
  const key = resolveBucket(q, buckets);
  if (!key || !task) return { key, task: key ? undefined : task };
  if (TASK_WORDS.test(q)) return { key: null, task };
  const t = q.toLowerCase().trim();
  const name = buckets.find((b) => b.key === key)?.name.toLowerCase() ?? "";
  const lead = [key.toLowerCase(), name, ...(BUCKET_ALIASES[key] ?? [])].some((n) => n && t.startsWith(n));
  return tokens(q).size <= 3 || lead ? { key, task: undefined } : { key: null, task };
}

export function ruleParse(text: string, now: Date, buckets: Pick<Bucket, "key" | "name">[]): ToolCall[] {
  // First try enhanced schedule editing patterns
  const scheduleCalls = parseScheduleEdit(text, now, buckets);
  if (scheduleCalls.length > 0) return scheduleCalls;
  
  const calls: ToolCall[] = [];
  const ctxDate = parseDate(text, now) ?? fmtDate(now);
  const whole = text.toLowerCase().trim();
  let em: RegExpMatchArray | null;
  if ((em = whole.match(/\b(?:email|e-mail|write to|message|draft (?:an? )?(?:email|note) to)\s+(?:my\s+|the\s+)?([\w.@+-]+(?:\s+counselor|\s+teacher)?)\s*(?:about|re|regarding|asking|to ask)?\s*(.*)$/))) {
    const topic = em[2].trim() || "a quick question";
    const subject = topic.charAt(0).toUpperCase() + topic.slice(1, 70);
    return [{ tool: "draft_email", args: { to: em[1], subject, reason: `you asked to email ${em[1]}`,
      body: `Hi,\n\nI wanted to reach out about ${topic}.\n\nThank you,\n` } }];
  }
  for (const clause of splitClauses(text)) {
    const c = clause.toLowerCase();
    const d = parseDate(c, now) ?? ctxDate;
    let m: RegExpMatchArray | null;
    if ((m = c.match(/^(?:i\s+)?(?:want|need|wanna|would like)\s+(?:to\s+(?:get|have|keep)\s+)?(an?\s+[abc][+-]?|\d{2,3}%?)\s+in\s+(?:my\s+)?(.+?)$/))
      || (m = c.match(/^(?:i\s+(?:want|need)\s+to\s+)?(?:raise|get|bring up|pull up|improve)\s+(?:my\s+)?(.+?)\s+(?:grade\s+)?to\s+(an?\s+[abc][+-]?|\d{2,3}%?)$/))) {
      const first = /^(an?\s+[abc]|\d)/.test(m[1]);
      const target = targetFrom(first ? m[1] : m[2]);
      const course = (first ? m[2] : m[1]).replace(/\s+grade$/, "").trim();
      if (target != null) { calls.push({ tool: "set_grade_target", args: { course, target } }); continue; }
    }
    if ((m = c.match(/^(?:i want to\s+|let me\s+|i'?ll\s+|i'?d rather\s+)?(?:do|work on|study)\s+(?:my\s+|the\s+)?(.+?)\s+(?:before|first,? then|ahead of)\s+(?:my\s+|the\s+)?(.+?)(?:\s+(?:tonight|today|tomorrow))?$/))) {
      calls.push({ tool: "order_blocks", args: { first: resolveBucket(m[1], buckets) ?? m[1], then: resolveBucket(m[2], buckets) ?? m[2], date: parseDate(c, now) } });
      continue;
    }
    if ((m = c.match(/^(?:i want to\s+|let me\s+|i'?ll\s+|i'?d rather\s+|i'?m going to\s+)?(?:do|work on|finish|knock out|tackle)\s+(?:my\s+|the\s+)?(.+?)\s+(?:on\s+|this\s+|next\s+)?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(morning|afternoon|evening|night))?$/))
      && TASK_WORDS.test(m[1])) {
      const d2 = parseDate(m[2], now);
      if (d2) { calls.push({ tool: "schedule_task", args: { task_query: m[1], date: d2, window: m[3] === "night" ? "evening" : m[3] ?? (m[2] === "tonight" ? "evening" : null) } }); continue; }
    }
    if ((m = c.match(/^(?:but\s+|and\s+|please\s+)?(?:keep|don'?t (?:move|touch)|do not (?:move|touch)|leave|lock|pin)\s+(?:my\s+|the\s+)?(.+?)(?:\s+(?:block|session))?(?:\s+(?:where it is|in place|as is|alone|the same|today|tonight|tomorrow|it has to be today))*[.!]?$/))
      && !/\b(everything|all|rest)\b/.test(m[1])) {
      const words = m[1].replace(/,.*$/, "").trim();
      const target = TASK_WORDS.test(words) ? words : resolveBucket(words, buckets) ?? words;
      const hasDay = parseDate(c, now);
      calls.push({ tool: "keep_block", args: { target, date: hasDay ?? null } });
      continue;
    }
    if ((m = c.match(/\b(grades?|score|scores|announcements?|news|syllabus|modules?|units?|missing(?:\s+assignments?)?|what'?s due|due this week|assignments?)\b(?:.*?\b(?:in|for)\s+(?:my\s+)?(.+?))?\??$/))
      && /\b(what|show|how|my|any|list|check|tell|whats|what's|missing)\b/.test(c)) {
      const k = m[1];
      const what = /grade|score/.test(k) ? "grades" : /announce|news/.test(k) ? "announcements" : /syllabus/.test(k) ? "syllabus"
        : /module|unit/.test(k) ? "modules" : "assignments";
      calls.push({ tool: "ask_canvas", args: { what, course: m[2]?.replace(/\b(class|course|right now|now)\b/g, "").trim() || null,
        search: /missing/.test(c) ? "missing" : null } });
      continue;
    }
    if ((m = c.match(/^(?:let'?s\s+)?(start|begin|pause|resume|stop|end|finish)\s+(?:a\s+|the\s+|my\s+)?(?:(.+?)\s+)?(?:timer|focus(?: mode| session)?|study mode|pomodoro|session)(?:\s+(?:for|on)\s+(.+))?$/)
      ?? c.match(/^(?:let'?s\s+)?(focus)\s+on\s+(.+)$/))) {
      const verb = m[1];
      const action = verb === "focus" || verb === "start" || verb === "begin" ? "start" : verb === "pause" ? "pause"
        : verb === "resume" ? "resume" : "stop";
      const target = (m[3] ?? m[2] ?? "").trim();
      calls.push({ tool: "timer", args: { action, target: target ? resolveBucket(target, buckets) ?? target : null } });
      continue;
    }
    if ((m = c.match(/\bi(?:'m| am| feel| feel like| felt)\s+(?:so\s+|really\s+|kinda\s+|pretty\s+|very\s+|super\s+)?(\w+)/))) {
      const w = m[1];
      const mood = /^(great|amazing|awesome|good|energized|motivated|productive|fine|okay|ok)$/.test(w)
        ? (/^(fine|okay|ok)$/.test(w) ? 3 : /^good$/.test(w) ? 4 : 5)
        : /^(tired|meh|bored|distracted|sleepy)$/.test(w) ? 2
          : /^(stressed|overwhelmed|exhausted|burnt|burned|anxious|sad|sick|drained|dead|cooked)$/.test(w) ? 1 : 0;
      if (mood) { calls.push({ tool: "check_in", args: { mood } }); continue; }
    }
    if ((m = c.match(/\b(?:pre-?clear|finish|knock out|get)\s+(?:my\s+)?(.+?)\s+(?:done\s+)?(?:before|by)\s+(.+)$/))) {
      const prev = [...calls].reverse().find((x) => x.tool === "add_event");
      const t = /^then\b/.test(m[2].trim()) && prev ? String(prev.args.start) : parseTime(m[2]);
      const dt = /^then\b/.test(m[2].trim()) && prev ? String(prev.args.date) : d;
      if (t) { calls.push({ tool: "preclear_task", args: { task_query: m[1], date: dt, before: t } }); continue; }
    }
    if (/\b(cancel|drop|skip|clear|no)\b.*\b(study|studying|block|blocks|session|work)\b/.test(c) && !/\bpre-?clear\b/.test(c)) {
      const a = c.match(/\bafter\s+(.+)$/);
      calls.push({ tool: "cancel_study", args: { date: d, after: a ? parseTime(a[1], true) : null } });
      continue;
    }
    if ((m = c.match(/(?:bump|set|change|raise|lower|increase|decrease|make|put)\s+(?:my\s+)?(.+?)\s+(?:(?:weekly\s+)?(?:target|goal|hours|bucket)(?:\s+\w+)?\s+)?(?:to|at|=)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)?/)) && !/\bestimate\b/.test(m[1])) {
      const b = resolveBucket(m[1], buckets);
      if (b) { calls.push({ tool: "set_bucket_target", args: { bucket: b, hours: Number(m[2]) } }); continue; }
    }
    if ((m = c.match(/\b(?:move|shift|push)\s+(?:my\s+)?(.+?)\s+(?:block\s+|session\s+)?to\s+(.+)$/))) {
      const to = parseDate(m[2], now);
      if (to) {
        const fromMatch = m[1].match(/\bfrom\s+(.+)$/);
        const target = (fromMatch ? m[1].slice(0, fromMatch.index) : m[1])
          .replace(/\s+(?:block|session)\s*$/i, "").replace(/^(?:my|the)\s+/i, "").trim();
        const fromDate = fromMatch ? parseDate(fromMatch[1], now) : null;
        calls.push({ tool: "move_block", args: {
          target: resolveBucket(target, buckets) ?? target,
          ...(fromDate ? { from_date: fromDate } : {}),
          to_date: to,
          window: parseWindow(m[2]) ?? "afternoon",
        } });
        continue;
      }
    }
    if ((m = c.match(/(?:mark|set|change|make|update)\s+(?:my\s+|the\s+)?(.+?)\s+estimate\s+(?:as|to|at|=)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)?\b/)
      ?? c.match(/^(?:my\s+|the\s+)?(.+?)\s+(?:will take|takes|should take|needs)\s+(?:like\s+|about\s+)?(?:(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?)|(an? hour and a half|half an hour|an? hour|a couple(?: of)? hours))\b/))) {
      const phrase = m[4];
      const mins = phrase
        ? (/half an hour/.test(phrase) ? 30 : /and a half/.test(phrase) ? 90 : /couple/.test(phrase) ? 120 : 60)
        : Number(m[2]) * ((m[3] ?? "").startsWith("h") ? 60 : 1);
      calls.push({ tool: "set_estimate", args: { task_query: m[1], minutes: Math.round(mins) } });
      continue;
    }
    if ((m = c.match(/(?:set|mark|make)\s+(?:my\s+)?(.+?)\s+(?:difficulty|load|cognitive load)\s+(?:as|to|at|=)\s+([1-5])/))
      ?? (m = c.match(/^(?:the\s+|my\s+)?(.+?)\s+is\s+.*?,\s*(?:difficulty|load)\s+([1-5])\b/))) {
      calls.push({ tool: "set_load", args: { task_query: m[1], cognitive_load: Number(m[2]) } });
      continue;
    }
    if ((m = c.match(/(?:mark|set)\s+(?:my\s+)?(.+?)\s+(?:as\s+)?(?:done|finished|complete|completed|submitted)$/)
      ?? c.match(/^i\s+(?:(?:already|just)\s+)?(?:finished|completed|submitted|turned in)\s+(?:my\s+|the\s+)?(.+)$/))) {
      calls.push({ tool: "mark_done", args: { task_query: m[1] } });
      continue;
    }
    if ((m = c.match(/(?:(?:i have|i've got|i got|there(?:'s| is)|attending|i'm going to|going to|add)\s+(?:a|an|my|the)?\s*)?(.+?)\s+(?:(?:tonight|today|tomorrow|this evening|(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)\w*)\s+)?(?:at|from)?\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?(?:\s+(?:to|until|till|-)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)?(?:\s+(?:tonight|today|tomorrow))?)$/))) {
      const title = m[1].replace(/\b(tonight|today|tomorrow|this evening|event|on|(?:mon|tue|wed|thu|fri|sat|sun)\w*)\b/g, "").trim() || "Event";
      const span = m[2].split(/\s+(?:to|until|till|-)\s+/);
      const hasMer = /\b(am|pm|a\.m\.|p\.m\.)/i.test(m[2]);
      const start = parseTime(span[0], true);
      if (start && (hasMer || /\b(at|from|tonight|today|tomorrow)\b/.test(c))) {
        const end = span[1] ? parseTime(span[1], true) : null;
        if (end && Number(end.slice(0, 2)) < Number(start.slice(0, 2)) && Number(start.slice(0, 2)) >= 12) {
          // e.g. "4 to 6pm": start got +12, or "7 to 10pm"
        }
        calls.push({ tool: "add_event", args: { title: title.replace(/\b\w/g, (x) => x.toUpperCase()), date: d, start, end } });
      }
    }
  }
  // The model is the only parser when one is loaded, but the rules path still has to cover the
  // newer tools so the app stays capable when the relay is unreachable.
  if (!calls.length) {
    const wants = intendedTools(text);
    const day = parseDate(text, now);
    if (wants.has("clear_day") && day) {
      return [{ tool: "clear_day", args: { date: day } }];
    }
    if (wants.has("set_weekly_focus")) {
      // Match on the original text so "AIME" keeps its capitalization.
      const m = text.match(/(?:this week|my focus|focus this week|priority this week|main goal)\s*(?:is|are|:|=)\s*(.+)$/i);
      const focus = m?.[1]?.trim().replace(/[.!?]+$/, "");
      if (focus && focus.length > 2) return [{ tool: "set_weekly_focus", args: { focus } }];
    }
    if (wants.has("set_priority")) {
      const low = /\b(low|less important|can wait|not urgent)\b/.test(whole);
      const high = /\b(high|top|most important|urgent|first)\b/.test(whole);
      const task = findTaskIn(text, buckets);
      if ((low || high) && task) {
        return [{ tool: "set_priority", args: { task_query: task, priority: low && !high ? "low" : "high" } }];
      }
    }
    if (wants.has("explain_plan")) {
      return [{ tool: "explain_plan", args: day ? { date: day } : {} }];
    }
  }
  return calls;
}

/** Best task title match for the rules path, or "" when nothing matches. */
function findTaskIn(text: string, _buckets: Pick<Bucket, "key" | "name">[]): string {
  const t = text.toLowerCase();
  const m = t.match(/(?:make|set|mark|bump|prioriti[sz]e)\s+(?:the\s+|my\s+)?(.+?)\s+(?:high|top|most important|low|less important|priority)/);
  return m?.[1]?.trim() ?? "";
}

/** Validate tool calls from the LLM; anything malformed is dropped. */
export function validateCalls(raw: unknown): ToolCall[] {
  const list = Array.isArray(raw) ? raw : (raw as { calls?: unknown })?.calls ?? (raw ? [raw] : []);
  if (!Array.isArray(list)) return [];
  const out: ToolCall[] = [];
  const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const isTime = (v: unknown) => {
    if (typeof v !== "string") return false;
    const m = v.match(/^(\d{2}):(\d{2})$/);
    return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
  };
  const normTime = (v: unknown) => {
    if (typeof v !== "string") return v;
    const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : v;
  };
  for (const c of list as Record<string, unknown>[]) {
    const tool = (c?.tool ?? c?.name) as ToolName;
    let args = (c?.args ?? c?.arguments ?? c?.parameters) as Record<string, unknown>;
    if (c && typeof c === "object") {
      // flat form {"tool":"x","date":…}, or stray keys next to "args": the other keys are arguments too
      const { tool: _t, name: _n, args: _a, arguments: _b, parameters: _p, ...rest } = c;
      if (args == null) args = rest;
      else if (typeof args === "object") args = { ...rest, ...args };
    }
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
    if (!(tool in TOOL_SPECS) || typeof args !== "object" || !args) continue;
    args = { ...args };
    if (tool === "ask_canvas" && args.what == null) args.what = args.ask ?? args.ask_type ?? args.type;
    for (const k of ["start", "end", "before", "after"]) if (args[k] != null) args[k] = normTime(args[k]);
    if (tool === "set_goal_days") normalizeDays(args, ["days"], []);
    if (tool === "set_schedule") {
      for (const k of TIME_SETTINGS) if (args[k] != null) args[k] = normTime(args[k]);
      // "quiet_weekend": ["Sunday"] means "no study on Sunday": that is a rest day, not a time window
      for (const k of ["quiet_weekday", "quiet_weekend"]) {
        const v = args[k];
        if (Array.isArray(v) && v.length && v.every((x) => dayNum(x) !== null)) {
          args.rest_days = [...new Set([...(Array.isArray(args.rest_days) ? args.rest_days : []), ...v])];
          delete args[k];
        }
      }
      normalizeDays(args, ["school_days", "rest_days"], ["school_end_by_day", "quiet_by_day"]);
      if (typeof args.school_end_by_day === "object" && args.school_end_by_day !== null && !Array.isArray(args.school_end_by_day)) {
        const overrides: Record<string, unknown> = {};
        for (const [day, time] of Object.entries(args.school_end_by_day)) overrides[day] = normTime(time);
        args.school_end_by_day = overrides;
      }
    }
    const ok = {
      add_event: () => typeof args.title === "string" && isDate(args.date) && isTime(args.start) && (args.end == null || args.end === "" || isTime(args.end)),
      preclear_task: () => typeof args.task_query === "string" && isDate(args.date) && isTime(args.before),
      cancel_study: () => isDate(args.date) && (args.after == null || isTime(args.after)),
      set_bucket_target: () => typeof args.bucket === "string" && Number.isFinite(Number(args.hours)) && Number(args.hours) >= 0 && Number(args.hours) <= 40,
      move_block: () => typeof args.target === "string" && isDate(args.to_date) && (args.from_date == null || isDate(args.from_date)),
      set_estimate: () => typeof args.task_query === "string" && Number(args.minutes) >= 5 && Number(args.minutes) <= 1200,
      set_load: () => typeof args.task_query === "string" && Number(args.cognitive_load) >= 1 && Number(args.cognitive_load) <= 5,
      mark_done: () => typeof args.task_query === "string",
      ask_canvas: () => ["grades", "assignments", "announcements", "modules", "syllabus", "courses"].includes(String(args.what)),
      timer: () => ["start", "pause", "resume", "stop"].includes(String(args.action)),
      draft_email: () => typeof args.to === "string" && typeof args.subject === "string" && typeof args.body === "string",
      check_in: () => Number(args.mood) >= 1 && Number(args.mood) <= 5,
      keep_block: () => typeof args.target === "string" && (args.date == null || isDate(args.date)),
      remove_block: () => typeof args.target === "string" && args.target.trim().length > 0 && (args.date == null || isDate(args.date)),
      add_exam: () => typeof args.course === "string" && args.course.trim().length > 0 && isDate(args.date)
        && (args.start == null || isTime(args.start))
        && (args.weight == null || (Number(args.weight) >= 0 && Number(args.weight) <= 100))
        && (args.units == null || (Array.isArray(args.units) && args.units.every((u) => typeof u === "string"))),
      set_weekly_focus: () => typeof args.focus === "string" && args.focus.trim().length > 2,
      clear_day: () => isDate(args.date),
      set_priority: () => typeof args.task_query === "string" && ["high", "normal", "low"].includes(String(args.priority)),
      explain_plan: () => args.date == null || isDate(args.date),
      set_grade_target: () => {
        if (typeof args.target === "string") args.target = targetFrom(args.target); // models often say "A"
        return typeof args.course === "string" && args.course.length > 1 && (args.target == null || (Number(args.target) >= 50 && Number(args.target) <= 110));
      },
      schedule_task: () => typeof args.task_query === "string" && isDate(args.date),
      order_blocks: () => typeof args.first === "string" && typeof args.then === "string" && args.first !== args.then && (args.date == null || isDate(args.date)),
      set_schedule: () => validateSchedulePatch(args) !== null,
      days_off: () => Array.isArray(args.dates) && args.dates.length > 0 && args.dates.length <= 21 && args.dates.every(isDate),
      set_goal_days: () => typeof args.bucket === "string" && Array.isArray(args.days) && args.days.length <= 7 &&
        args.days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7),
      add_task: () => typeof args.title === "string" && args.title.trim().length > 0 && args.title.length <= 160
        && isDate(args.due_date)
        && (args.description == null || (typeof args.description === "string" && args.description.length <= 500))
        && (args.course == null || (typeof args.course === "string" && args.course.trim().length > 0 && args.course.length <= 80))
        && (args.estimated_minutes == null || (Number.isInteger(Number(args.estimated_minutes)) && Number(args.estimated_minutes) >= 5 && Number(args.estimated_minutes) <= 1200)),
    }[tool]();
    if (ok) out.push({ tool, args });
  }
  return out;
}

/** Which tools a message could plausibly be asking for. Model calls outside this set are dropped,
 *  so a small model can't make changes nobody asked for (e.g. "I feel great" → three Canvas lookups). */
export function intendedTools(text: string): Set<ToolName> {
  const t = text.toLowerCase();
  const out = new Set<ToolName>();
  const on = (tool: ToolName, re: RegExp) => { if (re.test(t)) out.add(tool); };
  const timeish = /\b\d{1,2}(:\d{2})?\s*(am|pm)?\b|\bnoon\b|tonight|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend/;
  on("add_event", /practice|banquet|concert|meeting|game|appointment|dentist|doctor|debate|rehearsal|club|party|event|dinner with|tournament|competition|recital|class at|session at|going to|have (a |an )?\w+ (at|from|on)/);
  if (!timeish.test(t)) out.delete("add_event");
  on("preclear_task", /\b(before|by)\b.*\d|done before|finish(ed)? .*before|get .* done/);
  on("cancel_study", /no more stud|stop studying|cancel|night off|day off|skip (studying|tonight)|done studying|clear (my )?(evening|night)/);
  on("set_bucket_target", /hours? (a|per) week|\bgoal\b|target|bump|\bh\/w(ee)?k|weekly/);
  const tm = t.replace(/(don'?t|do not|never)\s+(move|touch|push)/g, "");
  if (/\bmove\b|\bpush\b|reschedule|shift|switch .* to|swap|later|earlier|instead|postpone|bump .* to (mon|tue|wed|thu|fri|sat|sun)/.test(tm)) out.add("move_block");
  on("schedule_task", /\b(do|work on|finish|get|spend|knock out|tackle|start)\b.*\b(on|this|next|tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/);
  on("order_blocks", /\b(before|after|first|then|ahead of|order)\b/);
  on("set_grade_target", /\b(grade|an? [abc][+-]?\b|get .+ to \d|raise|bring up|improve|pull up)\b/);
  on("set_schedule", /\b(?:change|set|update|adjust|move|shift|make|shorten|extend)\b.{0,60}\b(?:school|class|schedule|routine|dinner|sleep|bedtime|study window|quiet time|commute|break|school days|rest day)\b/);
  on("add_task", /\b(?:add|create|save|track|schedule)\b.{0,100}\b(?:task|milestone|deadline|roadmap|to-?do)\b/);
  on("keep_block", /\bkeep\b|don'?t (move|touch)|do not (move|touch)|\bleave\b|\block\b|\bpin\b|stay(s)? (where|put)|as is/);
  on("remove_block", /\b(remove|delete|drop|cancel|clear|get rid of|take out|skip)\b.{0,40}\b(block|session|slot|study time)\b|\b(remove|delete|drop|take out)\b.{0,30}\b(aime|usaaio|research|act|physics|self)\b/);
  on("clear_day", /\b(clear|wipe|empty|free up|nothing on|no study)\b.{0,25}\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|tomorrow|today)\b/);
  on("set_weekly_focus", /\b(this week|my focus|focus this week|priority this week|main goal)\b.{0,40}\b(is|are|:|=)\b/);
  on("set_priority", /\b(make|set|mark|bump|prioriti[sz]e)\b.{0,30}\b(high|top|most important|low|less important)\b.{0,30}\b(priority)?\b/);
  on("explain_plan", /\b(why|how come|explain|walk me through|what's the reasoning)\b.{0,40}\b(plan|schedule|today|tomorrow|week|block|workload)\b/);
  on("set_estimate", /\b(take|takes|took|taking)\b|\d+\s*(min|mins|minutes|hours?|hrs?)\b|hour and a half|half an hour|quick one|forever/);
  on("set_load", /hard|easy|difficult|brutal|tough|simple|difficulty|\bload\b|intense|killer/);
  on("mark_done", /\bdone\b|finished|turned in|submitted|completed|handed in|already did/);
  on("ask_canvas", /grade|score|assignment|announcement|missing|syllabus|module|due\b|canvas|\bnews\b|what'?s (up|new) in/);
  on("timer", /timer|focus|pomodoro|session|\bpause\b|\bresume\b|start (studying|working)|let'?s (study|work)/);
  on("draft_email", /email|e-mail|\bmail\b|write to|message (my|the)|reply to|counselor|teacher/);
  on("check_in", /feel|tired|burnt|burned out|exhausted|stress|great|awesome|motivated|sad|ugh|rough|meh|overwhelmed|anxious|happy|energ/);
  return out;
}

/** Final calls for the app: the rule parser's precise matches first, then model calls for anything
 *  the rules didn't cover. Model calls must pass the intent check. */
export function mergeCalls(model: ToolCall[], rules: ToolCall[], text: string): ToolCall[] {
  const ok = intendedTools(text);
  const gated = model.filter((c) => ok.has(c.tool));
  const ruleTools = new Set(rules.map((c) => c.tool));
  // never move something the student said to keep
  const sig = (v: unknown) => new Set(String(v ?? "").toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 2 && !STOP.has(w)));
  const kept = [...rules, ...gated].filter((c) => c.tool === "keep_block").map((c) => sig(c.args.target));
  const clashes = (c: ToolCall) => c.tool === "move_block" && kept.some((k) => [...sig(c.args.target)].some((w) => k.has(w)));
  const seen = new Set<string>();
  const out: ToolCall[] = [];
  for (const c of [...rules, ...gated.filter((c) => !ruleTools.has(c.tool))].filter((c) => !clashes(c))) {
    const k = c.tool + JSON.stringify(c.args);
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out.slice(0, 8);
}
