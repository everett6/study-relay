// Fallbacks used when WebGPU or the 3B model is unavailable: a workload estimator and a
// rule-based command parser that emits the same tool calls the LLM is asked for.

import { targetFrom } from "../core/grades";
import type { Bucket, Category, Task, TaskType } from "../core/types";
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
  | "schedule_task" | "order_blocks" | "set_grade_target";
export interface ToolCall { tool: ToolName; args: Record<string, unknown> }

export const TOOL_SPECS: Record<ToolName, string> = {
  add_event: "title:string, date:YYYY-MM-DD, start:HH:MM, end:HH:MM|null — scheduled event (banquet, practice, concert, meeting); pre-clears Tier 1 work due by tomorrow",
  preclear_task: "task_query:string, date:YYYY-MM-DD, before:HH:MM",
  cancel_study: "date:YYYY-MM-DD, after:HH:MM|null — drop study blocks until the sleep cutoff",
  set_bucket_target: "bucket:AIME|USAAIO|RESEARCH|ACT|PHYSICS, hours:number",
  move_block: "target:string (bucket key or task words), to_date:YYYY-MM-DD, window:morning|afternoon|evening — move ONE thing; the rest re-plans itself",
  schedule_task: "task_query:string, date:YYYY-MM-DD, window:morning|afternoon|evening|null — put ALL remaining work for one assignment on that day (\"do the essay on Saturday\")",
  order_blocks: "first:string, then:string, date:YYYY-MM-DD|null — reorder two blocks on a day so `first` comes before `then` (\"chem before calc tonight\")",
  set_grade_target: "course:string, target:number(percent)|null — the grade the student wants in a class; the planner gives below-goal classes more time and weekly review (\"I want an A in chem\", \"get precalc to 95\")",
  keep_block: "target:string (bucket key or task words), date:YYYY-MM-DD|null — pin it where it is so re-planning never moves it (\"keep\", \"don't move\", \"leave\")",
  set_estimate: "task_query:string, minutes:int",
  set_load: "task_query:string, cognitive_load:1-5",
  mark_done: "task_query:string",
  ask_canvas: "what:grades|assignments|announcements|modules|syllabus, course:string|null, search:string|null — read the student's Canvas classes",
  timer: "action:start|pause|resume|stop, target:string|null (bucket key or task words)",
  draft_email: "to:string (email or who, e.g. 'counselor'), subject:string, body:string, reason:string — creates a draft the student reviews; never sends",
  check_in: "mood:1-5 (1 rough .. 5 great) — the student said how they feel",
};

const BUCKET_ALIASES: Record<string, string[]> = {
  AIME: ["aime", "competition math", "comp math", "amc", "contest math"],
  USAAIO: ["usaaio", "usaio", "ai olympiad", "olympiad"],
  RESEARCH: ["research", "isef", "synopsys", "science fair"],
  ACT: ["act prep", "act"],
  PHYSICS: ["physics", "extra stem", "stem"],
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

/** Words that mean an assignment, not a weekly goal ("the physics lab" is a task, "physics" is a goal). */
export const TASK_WORDS = /\b(lab|homework|hw|reading|essay|quiz|test|exam|problem set|pset|project|assignment|worksheet|draft|annotations?|report)\b/i;

export function ruleParse(text: string, now: Date, buckets: Pick<Bucket, "key" | "name">[]): ToolCall[] {
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
      if (to) { calls.push({ tool: "move_block", args: { target: resolveBucket(m[1], buckets) ?? m[1], to_date: to, window: parseWindow(m[2]) ?? "afternoon" } }); continue; }
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
  return calls;
}

/** Validate tool calls from the LLM; anything malformed is dropped. */
export function validateCalls(raw: unknown): ToolCall[] {
  const list = Array.isArray(raw) ? raw : (raw as { calls?: unknown })?.calls ?? (raw ? [raw] : []);
  if (!Array.isArray(list)) return [];
  const out: ToolCall[] = [];
  const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const isTime = (v: unknown) => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
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
    const ok = {
      add_event: () => typeof args.title === "string" && isDate(args.date) && isTime(args.start),
      preclear_task: () => typeof args.task_query === "string" && isDate(args.date) && isTime(args.before),
      cancel_study: () => isDate(args.date) && (args.after == null || isTime(args.after)),
      set_bucket_target: () => typeof args.bucket === "string" && Number.isFinite(Number(args.hours)) && Number(args.hours) >= 0 && Number(args.hours) <= 40,
      move_block: () => typeof args.target === "string" && isDate(args.to_date),
      set_estimate: () => typeof args.task_query === "string" && Number(args.minutes) >= 5 && Number(args.minutes) <= 1200,
      set_load: () => typeof args.task_query === "string" && Number(args.cognitive_load) >= 1 && Number(args.cognitive_load) <= 5,
      mark_done: () => typeof args.task_query === "string",
      ask_canvas: () => ["grades", "assignments", "announcements", "modules", "syllabus", "courses"].includes(String(args.what)),
      timer: () => ["start", "pause", "resume", "stop"].includes(String(args.action)),
      draft_email: () => typeof args.to === "string" && typeof args.subject === "string" && typeof args.body === "string",
      check_in: () => Number(args.mood) >= 1 && Number(args.mood) <= 5,
      keep_block: () => typeof args.target === "string" && (args.date == null || isDate(args.date)),
      set_grade_target: () => {
        if (typeof args.target === "string") args.target = targetFrom(args.target); // models often say "A"
        return typeof args.course === "string" && args.course.length > 1 && (args.target == null || (Number(args.target) >= 50 && Number(args.target) <= 110));
      },
      schedule_task: () => typeof args.task_query === "string" && isDate(args.date),
      order_blocks: () => typeof args.first === "string" && typeof args.then === "string" && args.first !== args.then && (args.date == null || isDate(args.date)),
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
  on("keep_block", /\bkeep\b|don'?t (move|touch)|do not (move|touch)|\bleave\b|\block\b|\bpin\b|stay(s)? (where|put)|as is/);
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
  return out.slice(0, 4);
}
