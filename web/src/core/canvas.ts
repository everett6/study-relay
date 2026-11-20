// Canvas sync in the browser. Every request goes through the relay's /api/canvas/proxy
// (no CORS, and the relay can supply its own token from .env so the browser holds none).

import type { Category, Task } from "./types";
import { fmtLocal } from "./time";
import { TASK_TYPE } from "../ai/heuristics";

const RULES: [Category, RegExp][] = [
  ["test", /\b(test|exam|midterm|final|unit assessment|ap practice exam)\b/],
  ["quiz", /\bquiz(zes)?\b/],
  ["lab", /\blab\b/],
  ["project", /\b(project|essay|paper|presentation|dbq|leq|research|draft|portfolio)\b/],
];

export function classify(title: string, description = "", isQuiz = false): Category {
  const t = title.toLowerCase();
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  if (isQuiz) return "quiz";
  if (/\blab report\b/.test(description.toLowerCase())) return "lab";
  return "homework";
}

const KEEP = new Set(["AP", "IB", "AB", "BC", "II", "III", "US", "STEM"]);

/** "P-BIOLOGY - Q2000XX - NGUYEN - Period 04" -> "Biology"; normal names pass through. */
export function cleanCourse(name: string): string {
  let n = (name || "").trim().replace(/^[A-Z]{1,2}-(?=[A-Z])/, "");
  n = n.split(" - ")[0].trim();
  if (n && n === n.toUpperCase()) {
    n = n.split(/\s+/).map((w) => w.split("/").map((p) =>
      KEEP.has(p) || /\d/.test(p) ? p : p.charAt(0) + p.slice(1).toLowerCase()).join("/")).join(" ");
  }
  return n || name;
}

export function stripHtml(html: string): string {
  return (html || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

interface RawCourse {
  id: number | string; name: string;
  enrollments?: { type?: string; computed_current_score?: number | null; computed_current_grade?: string | null }[];
}
export interface GradeIn { course: string; score: number | null; grade: string | null }

/** Current score per course from a courses list fetched with include[]=total_scores. */
export function parseGrades(courses: RawCourse[]): GradeIn[] {
  return courses.map((c) => {
    const e = c.enrollments?.find((x) => !x.type || x.type === "student") ?? c.enrollments?.[0];
    return { course: cleanCourse(c.name), score: e?.computed_current_score ?? null, grade: e?.computed_current_grade ?? null };
  }).filter((g) => g.course);
}

export interface FlagIn { id: string; course: string; title: string; kind: "missing" | "zero"; points: number; score: number | null; due_at?: string; url?: string; can_submit: boolean }

/** Past-due missing work that hurts the grade (no redo assignments). */
export function parseFlags(course: RawCourse, list: RawAssignment[], now: Date): FlagIn[] {
  const name = cleanCourse(course.name);
  const out: FlagIn[] = [];
  for (const a of list) {
    const pts = a.points_possible ?? 0;
    const sub = a.submission;
    if (pts <= 0 || sub?.excused) continue;
    const due = a.due_at ? new Date(a.due_at) : null;
    const pastDue = !!due && due.getTime() < now.getTime();
    const types = (a.submission_types ?? []).filter((t) => t !== "none" && t !== "on_paper" && t !== "not_graded" && t !== "external_tool");
    const neverIn = pastDue && types.length > 0 && !sub?.submitted_at && (!sub || sub.workflow_state === "unsubmitted") && sub?.score == null;
    if (!sub?.missing && !neverIn) continue;
    out.push({ id: `canvas-${a.id}`, course: name, title: a.name.trim(), kind: "missing", points: pts,
      score: sub?.score ?? null, due_at: due ? fmtLocal(due) : undefined, url: a.html_url, can_submit: !a.locked_for_user });
  }
  return out;
}

/** Just the grades (one request). */
export async function fetchGrades(f: Fetcher): Promise<GradeIn[]> {
  return parseGrades(await getAll<RawCourse>(f, "/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=50"));
}
interface RawAssignment {
  id: number | string; name: string; description?: string | null; due_at?: string | null;
  points_possible?: number | null; submission_types?: string[]; is_quiz_assignment?: boolean;
  html_url?: string; locked_for_user?: boolean;
  submission?: {
    workflow_state?: string; submitted_at?: string | null; score?: number | null; missing?: boolean; excused?: boolean; late?: boolean;
    submission_comments?: { author_name?: string; comment?: string }[];
  } | null;
}

/** Convert Canvas assignments into open tasks (submitted ones are dropped). */
export function parseAssignments(course: RawCourse, list: RawAssignment[], now: Date): Task[] {
  const courseName = cleanCourse(course.name);
  const out: Task[] = [];
  for (const a of list) {
    const sub = a.submission;
    if (sub && (sub.submitted_at || ["submitted", "graded", "pending_review"].includes(sub.workflow_state ?? ""))) continue;
    const due = a.due_at ? new Date(a.due_at) : null;
    if (due && due.getTime() < now.getTime() - 3 * 86400000) continue; // long past
    const subTypes = (a.submission_types ?? []).filter((x) => x && x !== "none" && x !== "not_graded").map((x) => x.replace(/^online_/, "").replace(/_/g, " "));
    const desc = (stripHtml(a.description ?? "").slice(0, 2000) + (subTypes.length ? `\nSubmit: ${subTypes.join(", ")}` : "")).trim();
    const comments = (sub?.submission_comments ?? [])
      .map((c) => {
        const txt = stripHtml(c.comment ?? "");
        return txt ? (c.author_name ? `${c.author_name}: ${txt}` : txt) : "";
      })
      .filter(Boolean)
      .slice(-10);
    const cat = classify(a.name, desc, !!a.is_quiz_assignment || (a.submission_types ?? []).includes("online_quiz"));
    out.push({
      id: `canvas-${a.id}`, source: "canvas", course: courseName, title: a.name.trim(), description: desc,
      comments: comments.length ? comments : undefined,
      category: cat, task_type: TASK_TYPE[cat], points: a.points_possible ?? null,
      due_at: due ? fmtLocal(due) : undefined, cognitive_load: 3, llm_minutes: 0, estimated_minutes: 0,
      human_minutes: null, confidence: 0, recommended_45m_blocks: [], est_source: "heuristic",
      logged_minutes: 0, status: "open",
    });
  }
  return out;
}

/** Minimal VEVENT parser for the Canvas calendar feed (assignments show up as all-day or timed events). */
export function parseICS(text: string, now: Date): Task[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const out: Task[] = [];
  for (const ev of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const get = (k: string) => ev.match(new RegExp(`^${k}(?:;[^:]*)?:(.*)$`, "m"))?.[1]?.trim() ?? "";
    const summary = get("SUMMARY").replace(/\\,/g, ",").replace(/\\n/g, " ");
    const dt = get("DTSTART");
    if (!summary || !dt) continue;
    const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
    if (!m) continue;
    const due = m[4] === undefined ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59)
      : m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))
        : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (due.getTime() < now.getTime() - 86400000) continue;
    const cm = summary.match(/^(.*)\s\[(.+)\]$/); // "Lab 4 [AP Physics C]"
    const title = cm ? cm[1] : summary, course = cm ? cleanCourse(cm[2]) : "";
    const desc = get("DESCRIPTION").replace(/\\n/g, "\n").replace(/\\,/g, ",").slice(0, 1200);
    const cat = classify(title, desc);
    const uid = get("UID") || `${title}-${dt}`;
    out.push({
      id: `ics-${uid.replace(/[^\w-]/g, "").slice(0, 40)}`, source: "canvas", course, title, description: desc,
      category: cat, task_type: TASK_TYPE[cat], due_at: fmtLocal(due), cognitive_load: 3, llm_minutes: 0,
      estimated_minutes: 0, human_minutes: null, confidence: 0, recommended_45m_blocks: [], est_source: "heuristic",
      logged_minutes: 0, status: "open",
    });
  }
  return out;
}

export type Fetcher = (body: Record<string, string>) => Promise<{ status: number; json: unknown; text: string; next: string | null }>;

export function proxyFetcher(base = "", token?: string): Fetcher {
  return async (body) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const relay = localStorage.getItem("relay_token");
    if (relay) headers["X-Relay-Token"] = relay;
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`${base}/api/canvas/proxy`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* ICS or error page */ }
    return { status: r.status, json, text, next: r.headers.get("X-Canvas-Next") };
  };
}

async function getAll<T>(f: Fetcher, path: string, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let req: Record<string, string> = { path };
  for (let i = 0; i < maxPages; i++) {
    const r = await f(req);
    if (r.status === 401 || r.status === 403) throw new Error("Canvas rejected the token (401/403)");
    if (r.status >= 400) throw new Error(`Canvas error ${r.status}`);
    if (Array.isArray(r.json)) out.push(...(r.json as T[]));
    if (!r.next) break;
    req = { url: r.next };
  }
  return out;
}

/** Pull active courses and their upcoming assignments. */
export async function syncCanvas(f: Fetcher, now: Date): Promise<{ tasks: Task[]; courses: string[]; grades: GradeIn[]; flags: FlagIn[] | null }> {
  const courses = await getAll<RawCourse>(f, "/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=50");
  const tasks: Task[] = [];
  for (const c of courses) {
    const list = await getAll<RawAssignment>(f,
      `/api/v1/courses/${c.id}/assignments?include[]=submission&include[]=submission_comments&order_by=due_at&bucket=future&per_page=50`, 3)
      .catch(() => [] as RawAssignment[]);
    tasks.push(...parseAssignments(c, list, now));
  }
  // past work, for zeros and missing assignments (one or two pages per class)
  let flags: FlagIn[] | null = [];
  for (const c of courses) {
    const past = await getAll<RawAssignment>(f, `/api/v1/courses/${c.id}/assignments?include[]=submission&bucket=past&order_by=due_at&per_page=50`, 2)
      .catch(() => null);
    if (!past) { flags = null; break; } // couldn't read everything: keep the saved list as is
    flags.push(...parseFlags(c, past, now));
  }
  return { tasks, courses: courses.map((c) => cleanCourse(c.name)), grades: parseGrades(courses), flags };
}

export async function syncICS(f: Fetcher, icsUrl: string, now: Date): Promise<Task[]> {
  const r = await f({ ics_url: icsUrl });
  if (r.status >= 400) throw new Error(`calendar feed error ${r.status}`);
  return parseICS(r.text, now);
}

/** Realistic ESUHSD-style payload for demos and tests ("Sync mock" button). */
export function mockESUHSD(now: Date): Task[] {
  const at = (days: number, h: number, m = 59) => {
    const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString();
  };
  const courses: RawCourse[] = [
    { id: 101, name: "P-AP PHYSICS C MECH - S8100XP - RAMIREZ - Period 02" },
    { id: 102, name: "P-AP CALCULUS BC - M4700XP - KUANG - Period 03" },
    { id: 103, name: "P-AMERICAN LITERATURE H - E1300XH - PATEL - Period 05" },
    { id: 104, name: "P-CHEMISTRY H - S7300XH - NGUYEN - Period 06" },
  ];
  const raw: [number, RawAssignment][] = [
    [101, { id: 9001, name: "Problem Set 7: Rotational Dynamics", description: "<p>Problems 1-14, show free-body diagrams.</p>", due_at: at(1, 23), points_possible: 20 }],
    [101, { id: 9002, name: "Lab 4: Moment of Inertia", description: "<p>Full lab report with error analysis and uncertainty.</p>", due_at: at(4, 23), points_possible: 40 }],
    [102, { id: 9003, name: "HW 6.3 Integration by Parts", description: "<p>6.3 #1-29 odd</p>", due_at: at(1, 8, 30), points_possible: 10 }],
    [102, { id: 9004, name: "Unit 6 Test", description: "<p>Integration techniques. Calculator inactive.</p>", due_at: at(5, 8, 30), points_possible: 100 }],
    [103, { id: 9005, name: "Gatsby Chapter 5 Reading + Annotations", description: "<p>Read pp. 84-100 and annotate.</p>", due_at: at(2, 23), points_possible: 15 }],
    [103, { id: 9006, name: "Essay Draft: The American Dream", description: "<p>1000-1200 words, MLA format.</p>", due_at: at(7, 23), points_possible: 50 }],
    [104, { id: 9007, name: "Stoichiometry Quiz", description: "", due_at: at(3, 9), points_possible: 25, is_quiz_assignment: true }],
  ];
  return courses.flatMap((c) => parseAssignments(c, raw.filter(([id]) => id === c.id).map(([, a]) => a), now));
}

/** Merge freshly synced tasks into the existing list, keeping human edits and progress. */
export function mergeTasks(existing: Task[], incoming: Task[]): { tasks: Task[]; added: number } {
  const byId = new Map(existing.map((t) => [t.id, t]));
  let added = 0;
  for (const t of incoming) {
    const old = byId.get(t.id);
    if (!old) { byId.set(t.id, t); added++; continue; }
    byId.set(t.id, { ...old, title: t.title, course: t.course, description: t.description, comments: t.comments, due_at: t.due_at,
      points: t.points, category: old.est_source === "human" ? old.category : t.category });
  }
  return { tasks: [...byId.values()], added };
}
