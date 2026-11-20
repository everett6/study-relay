// Fixed benchmark for the in-browser models. Answers were written before any model ran.
// "Now" is Thursday 2026-11-19 15:00 (local), with the ESUHSD demo assignments loaded.
import { defaultState, type State } from "../src/core/types";
import { mockESUHSD } from "../src/core/canvas";
import { Store } from "../src/core/store";
import { Engine } from "../src/app/engine";
import { LLMClient } from "../src/ai/llmClient";
import { applyEstimate, heuristicEstimate, matchTasks, resolveBucket, type ToolCall } from "../src/ai/heuristics";

export const NOW = new Date(2026, 10, 19, 15, 0);
const TODAY = "2026-11-19", FRI = "2026-11-20", SAT = "2026-11-21", SUN = "2026-11-22";

export function buildState(): State {
  const s = defaultState();
  s.tasks = mockESUHSD(NOW).map((t) => applyEstimate(t, heuristicEstimate(t)));
  return s;
}

/** Same state with a real plan built by the engine, so the model sees blocks it may move or keep. */
export function buildPlannedState(): State {
  const store = new Store(null, false);
  store.state = defaultState();
  new Engine(store, new LLMClient(), () => NOW);
  store.update((st) => { st.tasks = buildState().tasks; });
  return store.state;
}

type A = Record<string, unknown>;
const str = (v: unknown) => String(v ?? "").toLowerCase();
const taskIs = (s: State, q: unknown, id: string) => matchTasks(String(q ?? ""), s.tasks.filter((t) => t.status === "open"))[0]?.id === id;
const bucketIs = (s: State, q: unknown, key: string) => str(q) === key.toLowerCase() || resolveBucket(String(q ?? ""), s.buckets) === key;
const time = (v: unknown) => String(v ?? "");

function has(calls: ToolCall[], tool: string, ok: (a: A) => boolean): boolean {
  return calls.some((c) => c.tool === tool && ok(c.args));
}

export interface Case { text: string; expect: string; check: (calls: ToolCall[], s: State) => boolean }

export const CASES: Case[] = [
  { text: "I have a banquet at 7 tonight", expect: "add_event today 19:00",
    check: (c) => has(c, "add_event", (a) => a.date === TODAY && time(a.start) === "19:00") },
  { text: "robotics practice tomorrow from 4 to 6pm", expect: "add_event Fri 16:00-18:00",
    check: (c) => has(c, "add_event", (a) => a.date === FRI && time(a.start) === "16:00" && time(a.end) === "18:00") },
  { text: "finish my physics problem set before 6:30 tonight", expect: "preclear PS7 today 18:30",
    check: (c, s) => has(c, "preclear_task", (a) => taskIs(s, a.task_query, "canvas-9001") && a.date === TODAY && time(a.before) === "18:30") },
  { text: "no more studying tonight after 8", expect: "cancel_study today after 20:00",
    check: (c) => has(c, "cancel_study", (a) => a.date === TODAY && time(a.after) === "20:00") },
  { text: "bump AIME to 8 hours a week", expect: "set_bucket_target AIME 8",
    check: (c, s) => has(c, "set_bucket_target", (a) => bucketIs(s, a.bucket, "AIME") && Number(a.hours) === 8) },
  { text: "move my ACT prep to saturday morning", expect: "move_block ACT Sat morning",
    check: (c, s) => has(c, "move_block", (a) => bucketIs(s, a.target, "ACT") && a.to_date === SAT && str(a.window) === "morning") },
  { text: "the calc homework will take like an hour and a half", expect: "set_estimate HW 6.3 90",
    check: (c, s) => has(c, "set_estimate", (a) => taskIs(s, a.task_query, "canvas-9003") && Number(a.minutes) === 90) },
  { text: "the moment of inertia lab is brutal, difficulty 5", expect: "set_load Lab 4 = 5",
    check: (c, s) => has(c, "set_load", (a) => taskIs(s, a.task_query, "canvas-9002") && Number(a.cognitive_load) === 5) },
  { text: "I already turned in the stoichiometry quiz", expect: "mark_done Stoich quiz",
    check: (c, s) => has(c, "mark_done", (a) => taskIs(s, a.task_query, "canvas-9007")) },
  { text: "what's my grade in chem right now?", expect: "ask_canvas grades chem",
    check: (c) => has(c, "ask_canvas", (a) => a.what === "grades" && str(a.course).includes("chem")) },
  { text: "do I have any missing assignments in calc?", expect: "ask_canvas assignments calc",
    check: (c) => has(c, "ask_canvas", (a) => a.what === "assignments" && str(a.course).includes("calc")) },
  { text: "start a focus session on my research", expect: "timer start RESEARCH",
    check: (c, s) => has(c, "timer", (a) => a.action === "start" && bucketIs(s, a.target, "RESEARCH")) },
  { text: "pause the timer", expect: "timer pause",
    check: (c) => has(c, "timer", (a) => a.action === "pause") },
  { text: "email my college counselor asking to meet next week", expect: "draft_email to counselor, no made-up address",
    check: (c) => has(c, "draft_email", (a) => str(a.to).includes("counselor") && !str(a.to).includes("@") && /meet/i.test(String(a.body ?? "") + String(a.subject ?? ""))) },
  { text: "ugh I'm so burnt out today", expect: "check_in mood <= 2",
    check: (c) => has(c, "check_in", (a) => Number(a.mood) <= 2) },
  { text: "honestly today was great, I feel super motivated", expect: "check_in mood >= 4",
    check: (c) => has(c, "check_in", (a) => Number(a.mood) >= 4) },
  { text: "I have debate at 6 tonight so get the gatsby reading done before then", expect: "add_event today 18:00 + preclear Gatsby 18:00",
    check: (c, s) => has(c, "add_event", (a) => a.date === TODAY && time(a.start) === "18:00")
      && has(c, "preclear_task", (a) => taskIs(s, a.task_query, "canvas-9005") && time(a.before) === "18:00") },
  { text: "push my USAAIO block to sunday afternoon and set the physics goal to 4 hours", expect: "move_block USAAIO Sun afternoon + PHYSICS 4",
    check: (c, s) => has(c, "move_block", (a) => bucketIs(s, a.target, "USAAIO") && a.to_date === SUN && str(a.window) === "afternoon")
      && has(c, "set_bucket_target", (a) => bucketIs(s, a.bucket, "PHYSICS") && Number(a.hours) === 4) },
  { text: "any new announcements in english?", expect: "ask_canvas announcements english",
    check: (c) => has(c, "ask_canvas", (a) => a.what === "announcements" && /engl|lit/.test(str(a.course))) },
  { text: "I'm going to a concert saturday 7 to 10pm", expect: "add_event Sat 19:00-22:00",
    check: (c) => has(c, "add_event", (a) => a.date === SAT && time(a.start) === "19:00" && time(a.end) === "22:00") },
];

const only = (calls: ToolCall[], tools: string[]) => calls.every((c) => tools.includes(c.tool));

/** Move-vs-keep set (added 2026-11-19, answers fixed before any model saw them). The state has a real plan. */
export const KEEP_CASES: Case[] = [
  { text: "keep my AIME block tonight but move research to saturday afternoon", expect: "keep_block AIME + move_block RESEARCH Sat afternoon",
    check: (c, s) => has(c, "keep_block", (a) => bucketIs(s, a.target, "AIME"))
      && has(c, "move_block", (a) => bucketIs(s, a.target, "RESEARCH") && a.to_date === SAT && str(a.window) === "afternoon")
      && !has(c, "move_block", (a) => bucketIs(s, a.target, "AIME")) },
  { text: "don't move the calc homework, it has to get done today", expect: "keep_block HW 6.3, nothing moved",
    check: (c, s) => has(c, "keep_block", (a) => taskIs(s, a.target, "canvas-9003")) && !c.some((x) => x.tool === "move_block") },
  { text: "dentist appointment tomorrow 4 to 5, keep everything else the same", expect: "add_event Fri 16:00-17:00 only",
    check: (c) => has(c, "add_event", (a) => a.date === FRI && time(a.start) === "16:00" && time(a.end) === "17:00")
      && only(c, ["add_event", "keep_block"]) },
  { text: "move the gatsby reading to tomorrow evening and leave the physics lab where it is", expect: "move_block Gatsby Fri evening + keep_block Lab 4",
    check: (c, s) => has(c, "move_block", (a) => taskIs(s, a.target, "canvas-9005") && a.to_date === FRI && str(a.window) === "evening")
      && has(c, "keep_block", (a) => taskIs(s, a.target, "canvas-9002")) },
];

/** Plausible focused-minutes ranges for the demo assignments, plus the right task type. */
export const ESTIMATES: Record<string, { lo: number; hi: number; type: string }> = {
  "canvas-9001": { lo: 40, hi: 150, type: "HW" },      // 14 physics problems with diagrams
  "canvas-9002": { lo: 60, hi: 240, type: "Lab" },     // full lab report, error analysis
  "canvas-9003": { lo: 30, hi: 120, type: "HW" },      // 6.3 #1-29 odd = 15 problems
  "canvas-9004": { lo: 90, hi: 480, type: "Exam" },    // unit test prep
  "canvas-9005": { lo: 20, hi: 90, type: "HW" },       // read 17 pages + annotate
  "canvas-9006": { lo: 90, hi: 360, type: "Project" }, // 1000-1200 word essay draft
  "canvas-9007": { lo: 20, hi: 120, type: "Quiz" },    // quiz prep
};

export interface ExtractCase { text: string; want: { word: RegExp; due: string; kind: "task" | "event" }[] }
export const EXTRACTS: ExtractCase[] = [
  { text: "To Do\nAP Physics C\nProblem Set 8\nDue Nov 24 at 11:59pm\n20 points\nAP Calculus BC\nQuiz 6.4\nDue Mon Nov 23 at 8:30am\nRobotics meeting Friday 3:45pm in room 210",
    want: [{ word: /problem set 8/i, due: "2026-11-24T23:59", kind: "task" }, { word: /quiz 6\.4/i, due: "2026-11-23T08:30", kind: "task" },
      { word: /robotics/i, due: "2026-11-20T15:45", kind: "event" }] },
  { text: "captain: reminder CAD files due this Sunday 9pm!! also build session sat 10am in the shop, bring safety glasses",
    want: [{ word: /cad/i, due: "2026-11-22T21:00", kind: "task" }, { word: /build/i, due: "2026-11-21T10:00", kind: "event" }] },
];

export function scoreExtract(found: { title: string; due: string | null; kind: string }[], c: ExtractCase): number {
  return c.want.filter((w) => found.some((f) => w.word.test(f.title) && f.due === w.due && f.kind === w.kind)).length;
}

/** Assign/reorder set (added 2026-11-19 21:05, answers fixed before any model saw them). */
export const ASSIGN_CASES: Case[] = [
  { text: "I want to do the essay draft on saturday", expect: "schedule_task Essay Draft Sat",
    check: (c, s) => has(c, "schedule_task", (a) => taskIs(s, a.task_query, "canvas-9006") && a.date === SAT) },
  { text: "do the physics problem set before the calc homework tonight", expect: "order_blocks PS7 then HW 6.3",
    check: (c, s) => has(c, "order_blocks", (a) => taskIs(s, a.first, "canvas-9001") && taskIs(s, a.then, "canvas-9003")) },
  { text: "work on the moment of inertia lab tomorrow afternoon", expect: "schedule_task Lab 4 Fri afternoon",
    check: (c, s) => has(c, "schedule_task", (a) => taskIs(s, a.task_query, "canvas-9002") && a.date === FRI && str(a.window) === "afternoon") },
];
