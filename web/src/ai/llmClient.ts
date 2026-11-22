// Browser LLM client. Loads a small model in a Web Worker on WebGPU only when the user asks
// for it (a one-time 0.7-2.3 GB download, cached by the browser afterwards). LFM3 runs through
// transformers.js (onnxruntime-web); the MLC builds run through WebLLM. Every call has a
// deterministic fallback, so the app works the same without WebGPU.

import type { AIMemoryMessage, Task, State } from "../core/types";
import { SCHOOL } from "../core/types";
import { addDays, fmtDate, fmtLocal, parseLocal, startOfDay } from "../core/time";
import { fixedSpans, isPianoItem } from "../core/schedule";
import { subjectFocus, type Focus } from "../core/grades";
import { heuristicEstimate, workSignals, matchTasks, ruleParse, TOOL_SPECS, validateCalls, type Estimate, type ToolCall, type ToolName } from "./heuristics";

export type Backend = "native" | "transformers" | "webllm";
export interface ModelInfo {
  id: string; label: string; size: string; backend: Backend;
  /** GPU memory it needs (MB), so the picker can warn on small GPUs (0 = runs on the relay machine) */
  vram: number;
  group: "Recommended" | "Small & fast" | "Bigger & smarter" | "Through your relay";
  /** has a reasoning ("thinking") mode that can be switched on */
  thinks?: boolean;
  note?: string;
}

// Benchmarked models first (see study-relay/bench). The rest are WebLLM prebuilt builds.
export const MODELS: ModelInfo[] = [
  { id: "onnx-community/LFM3-1.7B-ONNX", label: "LFM3 1.7B (Liquid)", size: "≈1.1 GB", backend: "transformers", vram: 1800, group: "Recommended", thinks: true },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen2.5 3B", size: "≈2.0 GB", backend: "webllm", vram: 2500, group: "Recommended" },
  { id: "Qwen3.5-2B-q4f16_1-MLC", label: "Qwen3.5 2B", size: "≈1.4 GB", backend: "webllm", vram: 2250, group: "Small & fast", thinks: true },
  { id: "Qwen3-1.7B-q4f16_1-MLC", label: "Qwen3 1.7B", size: "≈1.1 GB", backend: "webllm", vram: 2040, group: "Small & fast", thinks: true },
  { id: "LFM2.5-1.2B-Instruct-q4f16_1-MLC", label: "LFM2.5 1.2B", size: "≈0.7 GB", backend: "webllm", vram: 1000, group: "Small & fast", note: "lowest memory" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B", size: "≈0.7 GB", backend: "webllm", vram: 880, group: "Small & fast" },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B", size: "≈1.4 GB", backend: "webllm", vram: 1900, group: "Small & fast" },
  { id: "Qwen3.5-4B-q4f16_1-MLC", label: "Qwen3.5 4B", size: "≈2.6 GB", backend: "webllm", vram: 3870, group: "Bigger & smarter", thinks: true },
  { id: "Qwen3-4B-q4f16_1-MLC", label: "Qwen3 4B", size: "≈2.3 GB", backend: "webllm", vram: 3430, group: "Bigger & smarter", thinks: true },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", size: "≈2.3 GB", backend: "webllm", vram: 2260, group: "Bigger & smarter" },
  { id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC", label: "Hermes 3 3B (tool use)", size: "≈2.3 GB", backend: "webllm", vram: 2260, group: "Bigger & smarter" },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi-3.5 mini 3.8B", size: "≈2.4 GB", backend: "webllm", vram: 3670, group: "Bigger & smarter" },
  { id: "Qwen2.5-7B-Instruct-q4f16_1-MLC", label: "Qwen2.5 7B", size: "≈4.7 GB", backend: "webllm", vram: 5110, group: "Bigger & smarter", note: "needs a 6 GB+ GPU" },
  { id: "native", label: "Relay AI (gpt-6-luna or local LFM)", size: "no download", backend: "native", vram: 0, group: "Through your relay", note: "set it up in Settings → Connections" },
];

/** Token budget for prompts; also sizes the WebLLM KV cache. */
export const CONTEXT_TOKENS = 2048;

type Engine = { chat(request: Record<string, unknown>): Promise<string> };

/** "Thu 2026-11-19 (today), Fri 2026-11-20, …" so the model never has to do date math. */
export function weekLine(now: Date): string {
  return Array.from({ length: 8 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${fmtDate(d)}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`;
  }).join(", ");
}

/** LFM3's native tool-call format: <tool_call><function=NAME><parameter=K>V</parameter>…</function></tool_call>. */
export function parseToolXML(txt: string): { tool: string; args: Record<string, string> }[] {
  const calls: { tool: string; args: Record<string, string> }[] = [];
  for (const m of txt.matchAll(/<function=([\w-]+)>([\s\S]*?)<\/function>/g)) {
    const args: Record<string, string> = {};
    for (const p of m[2].matchAll(/<parameter=([\w-]+)>([\s\S]*?)<\/parameter>/g)) args[p[1]] = p[2].trim();
    calls.push({ tool: m[1], args });
  }
  return calls;
}

/** Scan text for balanced JSON object/array slices, respecting string literals. */
function balancedSlices(t: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const open = t[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) { out.push(t.slice(i, j + 1)); i = j; break; }
    }
  }
  return out;
}

/** Pull the JSON object or array out of a reply, ignoring any <think>…</think> reasoning.
 *  Replies made of native XML tool calls are converted to {calls, reply}. */
/** Rescue individual {"tool": …} objects from a reply whose overall JSON is broken. */
export function salvageCalls(txt: string): unknown[] {
  const out: unknown[] = [];
  for (const m of txt.matchAll(/\{\s*"(?:tool|name)"\s*:/g)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = m.index!; i < txt.length; i++) {
      const ch = txt[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { try { out.push(JSON.parse(txt.slice(m.index!, i + 1))); } catch { /* skip broken call */ } break; }
    }
  }
  return out;
}

/** Turn a prose reply that ignored the JSON-only instruction into something readable.
 *  Models often open with "The student is asking…" and list the tasks back; that preamble
 *  is noise, so drop it and keep the part that actually answers the question. */
export function salvageProse(txt: string): string {
  let t = txt.trim().replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```$/, "").trim();
  // Drop a leading JSON object the model half-wrote before switching to prose.
  const brace = t.indexOf("{");
  if (brace > 0 && brace < 40) t = t.slice(brace);
  // Strip leading reasoning: models that ignore "JSON only" often narrate their thinking
  // ("We need answer user. Need parse.") before the real answer. Drop those sentences.
  // A sentence may contain a quoted question with its own "?", so allow quoted spans
  // and match to the last terminator on the line rather than the first.
  const SENT = String.raw`"?(?:[^.!?\n]|"[^"\n]*")*[.!?]["\']?\s*`;
  const REASONING = new RegExp(`^(?:we|i)\\s+(?:need|should|must|will|can|have to|'ll)\\b${SENT}`, "i");
  const META = new RegExp(`^(?:the\\s+)?(?:user|student)\\s+(?:is|was|asked|wants?)\\b${SENT}`, "i");
  const PLANNING = new RegExp(`^(?:let me|so,?|okay,?|alright|first,?|next,?|now,?|hmm)\\b${SENT}`, "i");
  // Subject-less reasoning fragments: "Need parse.", "Must check the plan."
  const FRAGMENT = new RegExp(`^(?:need|must|should|have to|got ta|gotta|let's|maybe|probably|actually)\\b${SENT}`, "i");
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(REASONING, "").replace(META, "").replace(PLANNING, "").replace(FRAGMENT, "").trim();
    // A meta sentence can run into a second one ("…workload. They want to know…").
    t = t.replace(/^(?:they|it)\s+(?:want|wants|need|needs|is|are|ask|asks)\b[^.!?\n]*[.!?]\s*/i, "");
    if (t === before) break;
  }
  t = t.replace(/^["'\s]+|["'\s]+$/g, "").trim();
  // If the model only restated the question or narrated, that is not an answer.
  if (!t || REASONING.test(t) || META.test(t)) return "";
  return t.slice(0, 6000);
}

export function parseJSONReply(txt: string): unknown {
  const end = txt.lastIndexOf("</think>");
  let t = end >= 0 ? txt.slice(end + 8) : txt.replace(/^\s*<think>[\s\S]*$/, "");
  if (t.includes("<function=")) {
    const reply = t.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
    return { calls: parseToolXML(t), reply: reply.startsWith("{") ? "" : reply };
  }
  const fenced = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (let i = fenced.length - 1; i >= 0; i--) {
    try { return JSON.parse(fenced[i]); } catch { /* try earlier fence */ }
  }
  t = t.replace(/```(?:json)?/g, "");
  const slices = balancedSlices(t);
  for (let i = slices.length - 1; i >= 0; i--) {
    try { return JSON.parse(slices[i]); } catch { /* try earlier slice */ }
  }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ }
  }
  return null;
}

const shortDue = (iso: string | undefined, now: Date): string => {
  if (!iso) return "no due date";
  const d = parseLocal(iso);
  const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 && days < 7 ? d.toLocaleDateString("en-US", { weekday: "short" }) : iso.slice(5, 10);
  return `${days < 0 ? "OVERDUE " : ""}${day} ${iso.slice(11, 16)}`;
};

/** Today's and tomorrow's plan, each item tagged so the model knows what it may move:
 *  FIXED (school, meals, sleep, events), KEPT (pinned by the student), movable (placed by the planner). */
export function planLines(state: State, now: Date, days = 7): string {
  const out: string[] = [];
  const pianoTaskIds = new Set(state.tasks.filter(isPianoItem).map((t) => t.id));
  for (let i = 0; i < days; i++) {
    const day = addDays(startOfDay(now), i);
    const date = fmtDate(day);
    const items: [string, string][] = [];
    for (const f of fixedSpans(state.rules, day, state.events)) {
      if (f.e <= now || f.kind === "buffer") continue;
      const a = fmtLocal(f.s).slice(11), z = fmtLocal(f.e).slice(11);
      items.push([a, `${a}-${z} ${f.title.replace(/ \(hard cutoff\)/, "")} FIXED`]);
    }
    for (const b of state.blocks) {
      if (b.date !== date || parseLocal(b.end) <= now || isPianoItem(b) || (b.task_id && pianoTaskIds.has(b.task_id))) continue;
      const name = b.kind === "bucket" ? `${b.bucket} goal` : (b.title.split(": ").slice(1).join(": ") || b.title).slice(0, 44);
      const tag = b.status === "done" ? "done" : b.locked ? "KEPT" : "movable";
      items.push([b.start.slice(11), `${b.start.slice(11)}-${b.end.slice(11)} ${name} ${tag}`]);
    }
    items.sort((a, b) => a[0].localeCompare(b[0]));
    out.push(`${i === 0 ? "Today" : i === 1 ? "Tomorrow" : date}: ${items.map((x) => x[1]).join(" | ") || "(free)"}`);
  }
  return out.join("\n");
}

/** Context compression: the few tasks this message is about, plus the ones due soonest. */
export function relevantTasks(state: State, text: string, now: Date, max = 7): string {
  const open = state.tasks.filter((t) => t.status === "open" && !isPianoItem(t));
  const picked = new Map<string, Task>();
  for (const t of matchTasks(text, open).slice(0, 3)) picked.set(t.id, t);
  for (const t of [...open].sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9"))) {
    if (picked.size >= max) break;
    picked.set(t.id, t);
  }
  return [...picked.values()].map((t) => `- ${t.course}: ${t.title} · due ${shortDue(t.due_at, now)} · ${t.human_minutes ?? t.estimated_minutes ?? "?"}m`).join("\n");
}

/** Longer-term milestones saved from chat; these remain visible to the model outside the Week view. */
export function longRangeMilestones(state: State, now: Date, max = 12): string {
  const afterWeek = addDays(startOfDay(now), 7);
  return state.tasks
    .filter((t) => t.source === "assistant" && t.status === "open" && !!t.due_at
      && parseLocal(t.due_at) >= afterWeek && !isPianoItem(t))
    .sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""))
    .slice(0, max)
    .map((t) => `- ${t.due_at!.slice(0, 10)} ${t.course}: ${t.title}${t.description ? ` — ${t.description.slice(0, 140)}` : ""}`)
    .join("\n");
}

/** Instructions that don't change between messages. They come first and stay byte-identical,
 *  so the model's key/value cache for them is computed once and reused (prefix caching). */
export function plannerSystem(state: State): string {
  const specs = (Object.keys(TOOL_SPECS) as ToolName[]).map((k) => `${k}(${TOOL_SPECS[k]})`).join("\n");
  const goals = state.buckets.filter((b) => b.key !== SCHOOL).map((b) => `${b.key} = ${b.name}`).join("; ");
  return "You are an organized study-planning and college-planning coach for this high-school junior; follow any correction the student gives about their grade. Turn the message into appropriate tool calls and a genuinely useful answer. " +
    'Reply with JSON only: {"calls":[{"tool":"name","args":{...}}],"reply":"helpful answer"}.\n' +
    "CRITICAL: You MUST use tool calls to make ANY changes to the schedule. Do not just reply with text saying you'll do something — you must emit the tool call.\n" +
    "CRITICAL: Output the JSON object and nothing else. Never write your reasoning, never restate the question, never list the tasks back. If you are tempted to think out loud, put the finished answer in the reply field instead. A reply that begins with anything other than { is wrong.\n" +
    "Rules:\n" +
    "- Dates are YYYY-MM-DD, times 24h HH:MM. For the next 7 days copy dates from the Dates line. For farther horizons derive suggested target dates from Now and the student's stated goal; never present a calculated target as an official deadline.\n" +
    "- Evening words mean PM: \"7 tonight\" = 19:00, \"6:30 tonight\" = 18:30, \"4 to 6pm\" = 16:00-18:00.\n" +
    "- Usually ONE call. Use multiple calls only when the student asks for multiple changes or explicitly asks to save a roadmap's milestones (up to 8 add_task calls). Never add calls the student didn't ask for.\n" +
    "- After any change the planner re-plans everything else by itself. Only call tools for what the student asked to change.\n" +
    "- FIXED items (school, meals, sleep, events) and due dates never move. KEPT blocks stay where they are.\n" +
    "- Use set_schedule for explicit requests to change school days/hours, dismissal overrides, commute, breaks, dinner, sleep cutoff, study windows (weekday, weekend or day-specific), rest days or block lengths. Include only settings the student asked to change; unspecified rules stay as-is.\n" +
    "- Ignore all Piano-related tasks and events: do not schedule, estimate, move, mark done, pre-clear, or change them. They are outside this planner's scope.\n" +
    "- ACT prep is extracurricular, not school coursework. Keep ACT work in the ACT goal; never treat it as a school assignment.\n" +
    "- You can help plan from this week through several months or years. Week shows only its next 7 days; saved future milestones stay in Tasks and enter the Week plan as their due dates approach.\n" +
    "- For college guidance, use known student context and give practical, prioritized steps. Ask for important missing details (target year, location, interests/major, affordability) instead of inventing them. Distinguish suggested targets from official deadlines; don't invent school-specific dates or guarantee admission. Don't claim to be the student's actual school counselor or an admissions officer.\n" +
    "- If the student asks for advice or a roadmap, give a detailed, structured reply with useful headings, concrete steps/date ranges, assumptions, and an immediate next step. Use plain text, line breaks and hyphen bullets (no Markdown tables). For simple actions or factual questions, stay concise. Never claim an action succeeded unless its tool call did.\n" +
    "- Use add_task only when explicitly asked to save/add/track milestones. For college items use course \"College Planning\", a valid YYYY-MM-DD due_date, and label suggested dates as suggested in description; do not present them as official deadlines.\n" +
    "- \"keep\", \"don't move\", \"leave X\" -> keep_block X. \"move\" or \"push\" X -> move_block X and nothing else.\n" +
    "- A new appointment or activity -> add_event. \"Keep everything else the same\" needs no extra calls.\n" +
    "- Practices, banquets, concerts, meetings -> add_event. \"Finish X before TIME\" -> preclear_task. Focus sessions -> timer.\n" +
    "- Questions about grades, assignments or announcements -> ask_canvas.\n" +
    "- A grade goal (\"I want an A in chem\", \"get precalc to 95\") -> set_grade_target with the percent (A=93, A-=90, B+=87).\n" +
    "- Never invent email addresses; use a role like 'counselor'.\n" +
    "SCHEDULE EDITING EXAMPLES:\n" +
    "- \"Move my AIME block to Saturday afternoon\" -> move_block with target=\"AIME\", to_date=Saturday's date, window=\"afternoon\"\n" +
    "- \"I have a banquet at 7 tonight\" -> add_event with title=\"Banquet\", date=today, start=\"19:00\", end=\"21:00\"\n" +
    "- \"Cancel study after 8pm\" -> cancel_study with date=today, after=\"20:00\"\n" +
    "- \"Do the physics lab on Saturday morning\" -> schedule_task with task_query=\"physics lab\", date=Saturday, window=\"morning\"\n" +
    "- \"Chem before calc tonight\" -> order_blocks with first=\"chem\", then=\"calc\", date=today\n" +
    "- \"Keep my research block where it is\" -> keep_block with target=\"RESEARCH\"\n" +
    "- \"I want an A in chemistry\" -> set_grade_target with course=\"Chemistry\", target=93\n" +
    "- \"My chemistry exam is on the 24th, worth 40%\" -> add_exam with course, date, weight; the planner ramps study before it\n" +
    "- \"This week is all about the AIME\" -> set_weekly_focus with that focus\n" +
    "- \"Clear my whole Tuesday\" -> clear_day with that date\n" +
    "- \"Make the essay top priority\" / \"this can wait\" -> set_priority with priority high or low\n" +
    "- \"Why is my week like this?\" / \"explain my plan\" -> explain_plan, then answer in the reply\n" +
    `Goals (use the key): ${goals}\n` +
    `Tools:\n${specs}`;
}

/** Output shape for the planner. WebLLM enforces it while decoding (only real tool names can come out). */
/** One short line of grades for the model, weakest first: "Chemistry H 84% B ▼3 (goal 93, focus)". */
export function gradeLine(state: State, now: Date, max = 5): string {
  return subjectFocus(state, now).filter((f) => !/\bpiano\b/i.test(f.course)).slice(0, max).map((f) =>
    `${f.course} ${f.score}%${f.trend ? ` ${f.trend > 0 ? "▲" : "▼"}${Math.abs(f.trend)}` : ""}${f.level === "focus" || f.level === "watch" ? ` (goal ${f.target}, ${f.level})` : ""}`).join("; ");
}

export const ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    task_type: { type: "string", enum: ["HW", "Quiz", "Exam", "Project", "Lab"] },
    cognitive_load: { type: "integer" }, minutes: { type: "integer" }, confidence: { type: "number" }, why: { type: "string" },
  },
  required: ["task_type", "cognitive_load", "minutes", "confidence", "why"],
};

export const PLANNER_SCHEMA = {
  type: "object",
  properties: {
    calls: { type: "array", maxItems: 8, items: { type: "object", properties: {
      tool: { type: "string", enum: Object.keys(TOOL_SPECS) }, args: { type: "object" } }, required: ["tool", "args"] } },
    reply: { type: "string" },
  },
  required: ["calls", "reply"],
};

/** Shrink Canvas JSON before it goes into a prompt: drop ids, URLs, empty fields and HTML. */
export function compactData(data: unknown): string {
  const skip = /^(id|html_url|url|.*_id|.*_ids|avatar.*|lock_info|attachments|rubric.*|permissions|submission_types|created_at|updated_at)$/;
  return JSON.stringify(data, (k, v) => {
    if (k && skip.test(k)) return undefined;
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) return undefined;
    if (typeof v === "string") return v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
    return v;
  }) ?? "";
}

/** Thin RPC wrapper around a model worker (lfmWorker.ts or llmWorker.ts). */
function workerEngine(backend: Backend, onProgress: (p: { progress: number; text: string }) => void) {
  const worker = backend === "transformers"
    ? new Worker(new URL("./lfmWorker.ts", import.meta.url), { type: "module" })
    : new Worker(new URL("./llmWorker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  let stopped = false;
  const waiting = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  const failWaiting = (error: Error) => {
    for (const w of waiting.values()) w.fail(error);
    waiting.clear();
  };
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    if (m.type === "progress") return onProgress(m as unknown as { progress: number; text: string });
    if (m.type === "error") {
      failWaiting(new Error(String(m.error || "worker error")));
      return;
    }
    const w = waiting.get(m.id as number);
    if (!w) return;
    waiting.delete(m.id as number);
    if (m.ok) w.ok(m); else w.fail(new Error(String(m.error)));
  };
  worker.onerror = (e) => {
    const detail = e.message || (e.error instanceof Error ? e.error.message : "") || (e.filename ? `${e.filename}:${e.lineno}` : "");
    const msg = detail || "worker crashed (browser GPU/memory limit)";
    failWaiting(new Error(msg));
  };
  const call = (msg: Record<string, unknown>) => new Promise<Record<string, unknown>>((ok, fail) => {
    if (stopped) { fail(new Error("Model worker is no longer active")); return; }
    const id = ++seq;
    waiting.set(id, { ok, fail });
    worker.postMessage({ ...msg, id });
  });
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    failWaiting(new Error("Model load was superseded"));
  };
  return { call, terminate };
}

export type LLMStatus = { state: "off" | "unsupported" | "loading" | "ready" | "error"; progress: number; text: string; model?: string; modelLabel?: string; provider?: string; reason?: GpuProblem };
export type GpuProblem = "insecure" | "no-api" | "no-adapter";
export type GpuCheck = { ok: true } | { ok: false; reason: GpuProblem; text: string };

const GPU_TEXT: Record<GpuProblem, string> = {
  insecure: "WebGPU only works on https:// pages (or localhost). This page is plain http, so the browser hides the GPU.",
  "no-api": "This browser has WebGPU turned off. Chrome or Edge on Windows/Mac/ChromeOS have it; Firefox and some Linux setups don't.",
  "no-adapter": "The browser has WebGPU but the GPU didn't answer (this often happens after sleep or a graphics reset). Reloading the page usually fixes it.",
};

/** Ask for a GPU a few times (it can be briefly unavailable after sleep or a GPU-process restart) and say why if it fails. */
export async function checkWebGPU(tries = 3): Promise<GpuCheck> {
  if (typeof isSecureContext !== "undefined" && !isSecureContext) return { ok: false, reason: "insecure", text: GPU_TEXT.insecure };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<unknown> } }).gpu;
  if (!gpu) return { ok: false, reason: "no-api", text: GPU_TEXT["no-api"] };
  const prefs = [{ powerPreference: "high-performance" }, undefined, { powerPreference: "low-power" }];
  for (let i = 0; i < tries; i++) {
    try { if (await gpu.requestAdapter(prefs[i % prefs.length])) return { ok: true }; } catch { /* try again */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return { ok: false, reason: "no-adapter", text: GPU_TEXT["no-adapter"] };
}

export class LLMClient {
  status: LLMStatus = { state: "off", progress: 0, text: "Smart mode is off. Rules handle commands." };
  private engine: Engine | null = null;
  private activeWorker: ReturnType<typeof workerEngine> | null = null;
  private loadGeneration = 0;
  private onChange: (s: LLMStatus) => void;
  /** Reasoning/thinking enabled by default for Relay AI & thinking-capable models. */
  thinking = true;
  /** Last raw model reply (for the benchmark page). */
  lastRaw = "";
  /** Last model thinking/reasoning trace (from <think> tags or OpenRouter reasoning). */
  lastThinking = "";
  /** Preserved conversation turns across messages and model switches. */
  chatHistory: AIMemoryMessage[] = (() => {
    try {
      const raw = sessionStorage.getItem("studyflow_chat_history");
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      return Array.isArray(parsed)
        ? parsed.filter((m): m is AIMemoryMessage => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-16).map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }))
        : [];
    } catch { return []; }
  })();
  /** Prompt size of the last call in tokens (0 if the backend doesn't report it). */
  lastPromptTokens = 0;

  clearHistory(): void {
    this.chatHistory = [];
    try { sessionStorage.removeItem("studyflow_chat_history"); } catch { /* ignore */ }
  }

  restoreHistory(memory: AIMemoryMessage[] | undefined): void {
    if (memory === undefined) return;
    this.chatHistory = memory
      .filter((m) => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-16)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }));
    try { sessionStorage.removeItem("studyflow_chat_history"); } catch { /* ignore */ }
  }

  private saveHistory(): void {
    if (this.chatHistory.length > 16) this.chatHistory = this.chatHistory.slice(-16);
    this.chatHistory = this.chatHistory.map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }));
    try { sessionStorage.removeItem("studyflow_chat_history"); } catch { /* ignore */ }
  }

  constructor(onChange: (s: LLMStatus) => void = () => {}) { this.onChange = onChange; }

  static async supported(): Promise<boolean> { return (await checkWebGPU()).ok; }


  private set(s: Partial<LLMStatus>) { this.status = { ...this.status, ...s }; this.onChange(this.status); }

  get ready(): boolean { return this.status.state === "ready" && !!this.engine; }

  /** Terminate any running Web Worker and free GPU/RAM weights. */
  unload(): void {
    this.loadGeneration++;
    this.activeWorker?.terminate();
    this.activeWorker = null;
    this.engine = null;
    this.estCache.clear();
    this.set({ state: "off", progress: 0, model: undefined, modelLabel: undefined, provider: undefined, text: "Model unloaded. Rules handle commands." });
  }

  /** Check if the local/cloud Relay AI server (/api/llm/status) is reachable. */
  static async nativeStatus(token = ""): Promise<{ ok: boolean; model?: string; context_window?: number; url?: string; cloud?: boolean; error?: string }> {
    try {
      const headers: Record<string, string> = token ? { "X-Relay-Token": token } : {};
      const r = await fetch("/api/llm/status", { headers });
      if (!r.ok) return { ok: false };
      return await r.json();
    } catch { return { ok: false }; }
  }

  /** Opt-in model load (only call from a user click). Supports switching models cleanly. */
  async load(model: string = MODELS[0].id, opts: { thinking?: boolean; token?: string; prefixCache?: boolean } = {}): Promise<boolean> {
    const generation = ++this.loadGeneration;
    this.activeWorker?.terminate();
    this.activeWorker = null;
    this.engine = null;
    this.estCache.clear();
    try { localStorage.setItem("llm_model", model); } catch { /* ignore */ }
    const modelInfo = MODELS.find((m) => m.id === model);
    if (!modelInfo) {
      this.set({ state: "error", progress: 0, model, modelLabel: undefined, provider: undefined, reason: undefined, text: `Unknown model “${model}”. Choose a model again.` });
      return false;
    }
    const backend = modelInfo.backend;
    if (backend === "native") {
      this.thinking = opts.thinking ?? true;
      this.set({ state: "loading", progress: 0.2, text: "Connecting to Relay AI…", model, modelLabel: undefined, provider: undefined, reason: undefined });
      const st = await LLMClient.nativeStatus(opts.token);
      if (generation !== this.loadGeneration) return false;
      if (!st.ok) {
        this.set({ state: "error", progress: 0, modelLabel: undefined, provider: undefined,
          text: st.error ? `Relay AI: ${st.error}` : "Relay AI unreachable (check Settings → Connections or Ollama)." });
        return false;
      }
      const url = st.url ?? "";
      const provider = url.includes("openrouter.ai") ? "OpenRouter"
        : url.includes("openai.com") ? "OpenAI"
        : url.includes("azure.com") ? "Azure"
        : "Ollama";
      const modelName = st.model || "lfm2.5";
      if (generation !== this.loadGeneration) return false;
      this.engine = {
        chat: async (request) => {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (opts.token) headers["X-Relay-Token"] = opts.token;
          const r = await fetch("/api/llm/chat", { method: "POST", headers, body: JSON.stringify(request) });
          const d = await r.json().catch(() => ({})) as { content?: string; reasoning?: string; error?: string };
          if (!r.ok) {
            // 429 means the free tier is throttled, not that the app is broken — say so plainly.
            if (r.status === 429) throw new Error("Rate limited by the model provider. Wait a few seconds and retry, or switch to another model in Settings → Connections.");
            throw new Error(d.error || `HTTP ${r.status}`);
          }
          const reasoning = String(d.reasoning ?? "").trim();
          const content = String(d.content ?? "");
          // carry reasoning inline (per call) so concurrent background calls can't overwrite it
          return reasoning && content.trim() !== reasoning ? `<think>${reasoning}</think>${content}` : content;
        },
      };
      this.set({
        state: "ready", progress: 1, reason: undefined, model,
        modelLabel: modelName, provider,
        text: `${provider}: ${modelName}${st.cloud ? "" : ` (${Math.round((st.context_window ?? 32768) / 1024)}K ctx)`}`,
      });
      return true;
    }
    const gpu = await checkWebGPU();
    if (generation !== this.loadGeneration) return false;
    // in-browser models need WebGPU (LFM3's ONNX files use a GPU-only op, so there's no CPU path);
    // the app then offers the relay's model instead
    if (!gpu.ok) {
      this.set({ state: "unsupported", reason: gpu.reason, text: gpu.text, model, modelLabel: undefined, provider: undefined });
      return false;
    }
    this.set({ state: "loading", progress: 0, text: "Starting…", model, modelLabel: undefined, provider: undefined, reason: undefined });
    try {
      this.thinking = !!opts.thinking;
      const worker = workerEngine(backend, (p) => {
        if (generation === this.loadGeneration) this.set({ progress: p.progress, text: p.text });
      });
      this.activeWorker = worker;
      // ask the browser not to evict the cached model weights when storage runs low
      void navigator.storage?.persist?.().catch(() => false);
      await worker.call({ type: "load", model, contextTokens: CONTEXT_TOKENS, prefixCache: opts.prefixCache ?? true });
      if (generation !== this.loadGeneration) {
        worker.terminate();
        if (this.activeWorker === worker) this.activeWorker = null;
        return false;
      }
      this.engine = { chat: async (request) => {
        const r = await worker.call({ type: "chat", request });
        this.lastPromptTokens = Number(r.prompt_tokens) || 0;
        return String(r.content ?? "");
      } };
      const label = modelInfo.label;
      this.set({ state: "ready", progress: 1, reason: undefined, model, modelLabel: label, provider: "WebGPU", text: `${label} is running on your GPU` });
      return true;
    } catch (e) {
      if (generation !== this.loadGeneration) return false;
      this.activeWorker?.terminate();
      this.activeWorker = null;
      this.engine = null;
      this.set({ state: "error", progress: 0, modelLabel: undefined, provider: undefined, reason: undefined, text: `Couldn't load the model: ${String(e).slice(0, 140)}` });
      return false;
    }
  }

  /** `cachePrefix`: the leading part of `system` that is the same on every call (reused from the KV cache). */
  private async json(system: string, user: string, maxTokens = 400, cachePrefix = system, schema?: object, history: Array<{ role: "user" | "assistant"; content: string }> = []): Promise<unknown> {
    if (!this.engine) return null;
    let txt: string;
    this.lastThinking = "";
    try {
      txt = await this.engine.chat({
      messages: [{ role: "system", content: system }, ...history, { role: "user", content: user }],
      temperature: 0.1, max_tokens: this.thinking ? maxTokens + 1024 : maxTokens,
      response_format: { type: "json_object" }, enable_thinking: this.thinking, cache_prefix: cachePrefix,
      ...(schema ? { json_schema: JSON.stringify(schema) } : {}),
      });
    } catch (e) {
      this.lastRaw = `ERROR: ${String(e)}`;
      throw e;
    }
    this.lastRaw = txt;
    const thinkMatch = txt.match(/<think>([\s\S]*?)<\/think>/);
    this.lastThinking = thinkMatch?.[1]?.trim() ?? "";
    return parseJSONReply(txt);
  }

  /** Same as json() but returns this call's raw text + reasoning (safe against concurrent calls). */
  private async jsonCall(system: string, user: string, maxTokens: number, cachePrefix: string, schema: object | undefined,
    history: Array<{ role: "user" | "assistant"; content: string }>): Promise<{ value: unknown; raw: string; thinking: string }> {
    if (!this.engine) return { value: null, raw: "", thinking: "" };
    const txt = await this.engine.chat({
      messages: [{ role: "system", content: system }, ...history, { role: "user", content: user }],
      temperature: 0.1, max_tokens: this.thinking ? maxTokens + 1024 : maxTokens,
      response_format: { type: "json_object" }, enable_thinking: this.thinking, cache_prefix: cachePrefix,
      ...(schema ? { json_schema: JSON.stringify(schema) } : {}),
    });
    this.lastRaw = txt;
    const thinking = txt.match(/<think>([\s\S]*?)<\/think>/)?.[1]?.trim() ?? "";
    this.lastThinking = thinking;
    return { value: parseJSONReply(txt), raw: txt, thinking };
  }

  /** Real round-trip to the active model; returns latency or the error. */
  async ping(): Promise<{ ok: boolean; ms: number; error?: string }> {
    if (!this.engine) return { ok: false, ms: 0, error: "no model loaded" };
    const t0 = performance.now();
    try {
      await this.engine.chat({ messages: [{ role: "user", content: "Reply with: ok" }], temperature: 0, max_tokens: 64, enable_thinking: false });
      return { ok: true, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - t0), error: String((e as Error).message ?? e).slice(0, 200) };
    }
  }

  private estCache = new Map<string, Estimate>();

  /** Task Estimation Matrix entry. Falls back to the heuristic on any problem. */
  async estimate(t: Task, history: Task[] = [], grade?: Focus): Promise<Estimate> {
    const h = heuristicEstimate(t);
    if (!this.ready) return h;
    // the student's own corrected times, same course first, as calibration examples
    const past = history.filter((x) => x.id !== t.id && !isPianoItem(x) && x.human_minutes != null)
      .sort((a, b) => Number(b.course === t.course) - Number(a.course === t.course)).slice(0, 4);
    const cmts = (t.comments ?? []).join(" | ");
    const key = `${t.course}|${t.title}|${t.category}|${t.points ?? ""}|${(t.description ?? "").slice(0, 120)}|${cmts.slice(0, 80)}|${past.map((x) => x.human_minutes).join(",")}`;
    const cached = this.estCache.get(key);
    if (cached) return cached;
    try {
      const j = (await this.json(
        "You estimate high-school homework workload from the Canvas assignment. Reply with JSON only: " +
        '{"task_type":"HW|Quiz|Exam|Project|Lab","cognitive_load":1-5,"minutes":int,"confidence":0-1,"why":"<=12 words"}. ' +
        "minutes = focused time for a strong junior. Exams/projects/tests = total prep time. " +
        "Base minutes on the concrete Signals (problem count, words, pages, report parts). " +
        "If the student's past times are given, match their pace: they are ground truth. " +
        "cognitive_load: 1 = routine, 3 = normal, 5 = hard thinking (proofs, new topic, long writing). " +
        "why = the main reason, e.g. \"15 calc problems, ~3 min each\".",
        `Course: ${t.course}\nTitle: ${t.title}\nCategory: ${t.category}\nPoints: ${t.points ?? "?"}` +
        `\nSignals: ${workSignals(t).join("; ") || "none"}` +
        `\nQuick guess: ${h.minutes} min` +
        (grade ? `\nStudent's grade in this class: ${grade.score}% (goal ${grade.target}%${grade.trend ? `, ${grade.trend > 0 ? "up" : "down"} ${Math.abs(grade.trend)} pts lately` : ""})${grade.level === "focus" || grade.level === "watch" ? " - weaker class, allow extra time" : ""}` : "") +
        (past.length ? `\nStudent's past actual times:\n${past.map((x) => `- ${x.course}: ${x.title.slice(0, 50)} = ${x.human_minutes} min`).join("\n")}` : "") +
        `\nDirections: ${(t.description ?? "").slice(0, 1200) || "(none)"}` +
        (cmts ? `\nTeacher/Submission Comments: ${cmts.slice(0, 600)}` : ""),
        64, undefined, ESTIMATE_SCHEMA)) as Partial<Estimate> | null;
      const minutes = Number(j?.minutes), load = Number(j?.cognitive_load), conf = Number(j?.confidence);
      if (!j || !(minutes >= 5 && minutes <= 1200) || !(load >= 1 && load <= 5)) return h;
      const types = ["HW", "Quiz", "Exam", "Project", "Lab"];
      const res: Estimate = { task_type: types.includes(String(j.task_type)) ? j.task_type as Estimate["task_type"] : h.task_type,
        cognitive_load: Math.round(load), minutes: Math.round(minutes / 5) * 5,
        confidence: Number.isFinite(conf) ? Math.min(0.95, Math.max(0.2, conf)) : 0.7, source: "llm",
        why: typeof j.why === "string" && j.why.trim() ? j.why.trim().slice(0, 100) : h.why };
      if (this.estCache.size > 200) this.estCache.clear();
      this.estCache.set(key, res);
      return res;
    } catch { return h; }
  }

  /** Turn a chat/voice message into tool calls plus a short spoken-style reply.
   *  The AI is the primary parser: every message goes to the model when one is loaded.
   *  Rules are only a safety net when the model is unavailable, errors, or returns nothing usable. */
  /** `calls` is what the app runs; `modelCalls` is the model alone. */
  async command(text: string, state: State, now: Date, opts: { fallback?: boolean } = {}): Promise<{ calls: ToolCall[]; modelCalls: ToolCall[]; reply: string; thinking: string; via: "llm" | "rules" }> {
    const fallback = opts.fallback ?? true;
    const rules = fallback ? ruleParse(text, now, state.buckets) : [];
    if (!this.ready) return { calls: rules, modelCalls: [], reply: "", thinking: "", via: "rules" };
    try {
      const fixed = plannerSystem(state);
      const bucketSummary = state.buckets.filter((b) => b.key !== SCHOOL).map((b) => `${b.key} ${Math.round(b.logged_minutes / 60 * 10) / 10}/${b.target_hours}h`).join(", ");
      const rulesSummary = `${state.rules.block_min}m blocks, ${state.rules.break_min}m breaks, dinner ${state.rules.dinner_start} (${state.rules.dinner_min}m), sleep ${state.rules.sleep_cutoff}`;
      const savedMilestones = longRangeMilestones(state, now);
      const context = `\n\nBackground (only to look up names, dates and what may move; act ONLY on the student's message):\n` +
        `Now: ${now.toLocaleDateString("en-US", { weekday: "short" })} ${fmtDate(now)} ${now.toTimeString().slice(0, 5)}\n` +
        `Dates: ${weekLine(now)}\n` +
        `Rules: ${rulesSummary}\n` +
        (bucketSummary ? `Buckets: ${bucketSummary}\n` : "") +
        `Plan (same next 7 days shown in the Week calendar):\n${planLines(state, now, 7)}\n` +
        `Open tasks:\n${relevantTasks(state, text, now, 15) || "(none)"}` +
        (savedMilestones ? `\nSaved long-range milestones:\n${savedMilestones}` : "") +
        ((state.grades ?? []).some((g) => !/\bpiano\b/i.test(g.course)) ? `\nGrades (weakest first): ${gradeLine(state, now)}` : "") +
        ((state.flags ?? []).some((f) => f.status !== "dismissed" && !/\bpiano\b/i.test(`${f.course} ${f.title}`))
          ? `\nZeros/missing: ${(state.flags ?? []).filter((f) => f.status !== "dismissed" && !/\bpiano\b/i.test(`${f.course} ${f.title}`)).slice(0, 4).map((f) => `${f.course}: ${f.title} (${f.kind === "zero" ? `0/${f.points}` : "missing"}${f.status === "planned" ? ", make-up planned" : ""})`).join("; ")}` : "") +
        // Add current timer state if running
        (state.timer.state !== "idle" ? `\nActive timer: ${state.timer.bucket ?? "Study"} ${state.timer.planned_min ? `(${state.timer.planned_min} min planned)` : ""}` : "") +
        // Add momentum mode
        (state.momentum ? `\nCurrent workload mode: ${state.momentum.mode}` : "");
      const detailed = /\b(plan|planning|roadmap|timeline|colleges?|applications?|admissions?|career|months?|years?|long[- ]term|explain|compare|financial aid|scholarship|future|guidance|advice|what should|how can)\b/i.test(text);
      // Send more history for better context (12 turns instead of 6)
      const historyForModel = this.chatHistory.slice(-12);
      const res = await this.jsonCall(fixed + context, text, detailed ? 1800 : 900, fixed, PLANNER_SCHEMA, historyForModel);
      const j = res.value as { calls?: unknown; reply?: unknown } | null;
      let raw = validateCalls(j?.calls ?? []);
      if (!raw.length) raw = validateCalls(salvageCalls(res.raw));
      let reply = typeof j?.reply === "string" ? j.reply.slice(0, 6000) : "";
      if (!reply && res.raw) {
        // The model ignored "JSON only" and wrote prose. That prose is still the answer —
        // salvage it instead of showing the student a canned "I didn't catch that".
        const cleaned = res.raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (cleaned && !cleaned.startsWith("{")) reply = salvageProse(cleaned);
      }
      // The model is the only parser. Rules are used ONLY when no model is loaded or the call throws —
      // never merged into a model turn, so what the AI decided is exactly what runs.
      const modelCalls = raw.slice(0, 8);
      const calls = modelCalls;
      this.chatHistory.push({ role: "user", content: text });
      if (reply || calls.length) {
        this.chatHistory.push({ role: "assistant", content: (reply || calls.map((c) => c.tool).join(", ")).slice(0, 3000) });
      }
      this.saveHistory();
      return { calls, modelCalls, reply, thinking: res.thinking, via: reply || modelCalls.length ? "llm" : "rules" };
    } catch (e) {
      return { calls: rules, modelCalls: [], reply: rules.length ? "" : `AI error: ${String((e as Error).message ?? e).slice(0, 200)}`, thinking: "", via: "rules" };
    }
  }

  /** Free-form answer grounded on data (e.g. Canvas results). Returns "" without the model. */
  async summarize(question: string, data: unknown): Promise<string> {
    if (!this.ready) return "";
    try {
      const j = (await this.json("Answer the student's question clearly and with enough detail to be useful, using only this data. " +
        "Include relevant dates and key items; use short bullets if there are several. Do not infer facts missing from the data. " +
        'Reply as JSON {"answer":"..."}.', `Question: ${question}\nData: ${compactData(data).slice(0, 2400)}`, 500)) as { answer?: string } | null;
      return typeof j?.answer === "string" ? j.answer.slice(0, 3000) : "";
    } catch { return ""; }
  }

  /** Body for a reply to an email the student received ("" without the model). */
  async draftReply(from: string, subject: string, text: string): Promise<string> {
    if (!this.ready) return "";
    try {
      const j = (await this.json("Write a short, polite reply from a high-school junior. Plain text, under 120 words, " +
        'no placeholders except [time] if a time is needed. JSON {"body":"..."}.', `From: ${from}\nSubject: ${subject}\n\n${text.slice(0, 2000)}`, 300)) as { body?: string } | null;
      return typeof j?.body === "string" ? j.body : "";
    } catch { return ""; }
  }

  /** Pull tasks/events out of OCR'd screenshot text. */
  async extract(text: string, now: Date): Promise<{ title: string; course: string; due: string | null; kind: "task" | "event"; minutes: number | null }[]> {
    if (!this.ready) return [];
    try {
      const j = await this.json(
        "From this screenshot text, list school tasks or events. Copy dates from the Dates line. JSON only: " +
        '{"items":[{"title":"","course":"","due":"YYYY-MM-DDTHH:MM or null","kind":"task|event","minutes":int|null}]}',
        `Dates: ${weekLine(now)}\nText:\n${text.slice(0, 2500)}`, 500) as { items?: unknown[] } | unknown[] | null;
      const items = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [];
      return items.flatMap((x) => {
        const it = x as Record<string, unknown>;
        if (typeof it.title !== "string" || !it.title.trim()) return [];
        const m = typeof it.due === "string" ? it.due.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/) : null;
        const due = m ? `${m[1]}T${m[2]}` : null;
        return [{ title: it.title.slice(0, 120), course: typeof it.course === "string" ? it.course.slice(0, 60) : "",
          due, kind: it.kind === "event" ? "event" as const : "task" as const,
          minutes: Number(it.minutes) >= 5 && Number(it.minutes) <= 600 ? Math.round(Number(it.minutes)) : null }];
      });
    } catch { return []; }
  }
}
