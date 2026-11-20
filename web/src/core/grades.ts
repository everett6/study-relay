// Course grades -> "subject focus": which classes need more time, and how much.
// Pure functions shared by the planner, the UI, the LLM context and tests.
import type { CourseGrade, State } from "./types";
import { addDays, fmtDate, fmtLocal } from "./time";

export const DEFAULT_TARGET = 93;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round5 = (n: number) => Math.round(n / 5) * 5;

/** Merge fresh Canvas scores into the saved list: one history point per day, last 40 kept. */
export function recordGrades(list: CourseGrade[] | undefined, fresh: { course: string; score: number | null; grade: string | null }[], now: Date): CourseGrade[] {
  const day = fmtDate(now);
  const out = (list ?? []).map((g) => ({ ...g, history: [...g.history] }));
  for (const f of fresh) {
    if (!f.course) continue;
    let g = out.find((x) => x.course === f.course);
    if (!g) { g = { course: f.course, score: null, grade: null, history: [], updated: "" }; out.push(g); }
    g.score = f.score == null ? null : round1(f.score);
    g.grade = f.grade;
    g.updated = fmtLocal(now);
    if (g.score != null) {
      const last = g.history[g.history.length - 1];
      if (last?.date === day) last.score = g.score;
      else g.history.push({ date: day, score: g.score });
      g.history = g.history.slice(-40);
    }
  }
  return out;
}

/** Points gained (+) or lost (-) compared with about two weeks ago (oldest point in the last 21 days). */
export function gradeTrend(g: CourseGrade, now: Date): number | null {
  if (g.score == null) return null;
  const today = fmtDate(now), cutoff = fmtDate(addDays(now, -21));
  const base = g.history.find((h) => h.date >= cutoff && h.date < today) ?? (g.history.length > 1 ? g.history[g.history.length - 2] : undefined);
  return base ? round1(g.score - base.score) : null;
}

export type FocusLevel = "focus" | "watch" | "improving" | "ok";
export interface Focus {
  course: string; score: number; grade: string | null; target: number; gap: number; trend: number | null;
  level: FocusLevel;
  /** multiplier on this course's homework time (1 = no change, max 1.4) */
  boost: number;
  /** extra weekly review minutes the planner adds for this course */
  reviewMin: number;
  reason: string;
}

/** How much attention each graded course needs. Below-goal and slipping courses get more time. */
export function subjectFocus(st: Pick<State, "grades"> & Partial<Pick<State, "flags">>, now: Date): Focus[] {
  const out: Focus[] = [];
  const open = (st.flags ?? []).filter((f) => f.status !== "dismissed");
  for (const g of st.grades ?? []) {
    if (g.score == null || g.ignore) continue;
    const target = g.target ?? DEFAULT_TARGET;
    const gap = round1(Math.max(0, target - g.score));
    const trend = gradeTrend(g, now);
    const drop = Math.max(0, -(trend ?? 0));
    const boost = round1(1 + Math.min(0.4, gap * 0.03 + drop * 0.05) + 1e-9);
    const reviewMin = gap >= 2 || drop >= 2 ? Math.min(120, Math.max(30, round5(20 + gap * 6 + drop * 8))) : 0;
    const mine = matchCourseFlags(open, g.course);
    let level: FocusLevel = reviewMin ? (gap >= 5 || drop >= 3 ? "focus" : "watch") : (trend ?? 0) >= 1 ? "improving" : "ok";
    if (mine.length && (level === "ok" || level === "improving")) level = "watch";
    const bits: string[] = [];
    const zeros = mine.filter((f) => f.kind === "zero").length, missing = mine.length - zeros;
    if (zeros) bits.push(`${zeros} zero${zeros > 1 ? "s" : ""}`);
    if (missing) bits.push(`${missing} missing`);
    if (gap > 0) bits.push(`${gap} below your ${target}% goal`);
    if (drop >= 1) bits.push(`down ${drop} pts in 2 weeks`);
    if ((trend ?? 0) >= 1) bits.push(`up ${trend} pts in 2 weeks`);
    out.push({ course: g.course, score: g.score, grade: g.grade, target, gap, trend, level, boost, reviewMin,
      reason: bits.join(", ") || "at or above your goal" });
  }
  const rank: Record<FocusLevel, number> = { focus: 0, watch: 1, improving: 2, ok: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || b.gap - a.gap);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Match a course name loosely ("Precalculus/AP" ~ "precalculus", "chem" ~ "Chemistry H"). */
export function matchCourse<T extends { course: string }>(list: T[], course: string | undefined): T | undefined {
  if (!course) return undefined;
  const c = norm(course);
  if (!c) return undefined;
  const w = c.split(" ")[0];
  return list.find((f) => norm(f.course) === c) ?? list.find((f) => { const n = norm(f.course); return n.startsWith(c) || c.startsWith(n); })
    ?? list.find((f) => w.length >= 4 && norm(f.course).split(" ").some((x) => x.startsWith(w)));
}
export const focusFor = (focus: Focus[], course: string | undefined): Focus | undefined => matchCourse(focus, course);

const matchCourseFlags = <T extends { course: string }>(flags: T[], course: string) => flags.filter((f) => norm(f.course) === norm(course));

/** Letter grades people type ("an A-") to a percent goal. */
export function targetFrom(text: string): number | null {
  const t = text.trim().toUpperCase().replace(/^AN?\s+/, "");
  const letters: Record<string, number> = { "A+": 97, A: 93, "A-": 90, "B+": 87, B: 83, "B-": 80, "C+": 77, C: 73 };
  if (t in letters) return letters[t];
  const n = Number(t.replace("%", ""));
  return n >= 50 && n <= 110 ? n : null;
}
