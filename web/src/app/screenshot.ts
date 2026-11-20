// Screenshots: paste, drop or pick an image (Canvas to-do list, a club flyer, a group chat),
// read its text in the browser (OCR) and turn it into tasks or events the student reviews.

import { addDays, fmtLocal, pad } from "../core/time";

export interface Found { title: string; course: string; due: string | null; kind: "task" | "event"; minutes: number | null }

type TextDetectorCtor = new () => { detect(img: ImageBitmap): Promise<{ rawValue: string }[]> };

let worker: Promise<{ recognize(img: Blob): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> }> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWorkerCleanup() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const p = worker;
    worker = null;
    p?.then((w) => w.terminate()).catch(() => {});
  }, 60_000);
}

/** Downscale large screenshots (>1600px) before OCR to prevent WASM/canvas OOM spikes. */
async function downscaleForOCR(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  const bmp = await createImageBitmap(file);
  try {
    const maxEdge = 1600;
    if (bmp.width <= maxEdge && bmp.height <= maxEdge) return file;
    const scale = maxEdge / Math.max(bmp.width, bmp.height);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    const resized = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    c.width = 0; c.height = 0;
    return resized ?? file;
  } finally {
    bmp.close();
  }
}

/** OCR in the browser. Uses the built-in TextDetector when present, otherwise tesseract.js (lazy-loaded). */
export async function readImage(file: Blob, onProgress: (p: number, msg: string) => void = () => {}): Promise<string> {
  const TD = (window as unknown as { TextDetector?: TextDetectorCtor }).TextDetector;
  if (TD) {
    const bmp = await createImageBitmap(file);
    try {
      const lines = await new TD().detect(bmp);
      if (lines.length) return lines.map((l) => l.rawValue).join("\n");
    } catch { /* fall through */ } finally {
      bmp.close();
    }
  }
  const input = await downscaleForOCR(file);
  onProgress(0.05, "Loading the text reader (first time only)…");
  worker ??= import("tesseract.js").then((T) => T.createWorker("eng", 1, {
    logger: (m: { status: string; progress: number }) => onProgress(m.progress, m.status),
  }));
  const w = await worker;
  try {
    const r = await w.recognize(input);
    return r.data.text;
  } finally {
    scheduleWorkerCleanup();
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Find a date/time in a line. Returns local ISO "YYYY-MM-DDTHH:MM" or null. */
export function findDate(line: string, now: Date): string | null {
  const l = line.toLowerCase();
  let day: Date | null = null;
  let m: RegExpMatchArray | null;
  if (/\btoday|tonight\b/.test(l)) day = new Date(now);
  else if (/\btomorrow\b/.test(l)) day = addDays(now, 1);
  else if ((m = l.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/))) {
    day = new Date(now.getFullYear(), MONTHS.indexOf(m[1]), Number(m[2]));
    if (day.getTime() < now.getTime() - 60 * 86400000) day.setFullYear(day.getFullYear() + 1);
  } else if ((m = l.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
    day = new Date(y, Number(m[1]) - 1, Number(m[2]));
  } else if ((m = l.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/))) {
    const diff = (DAYS.indexOf(m[1]) - now.getDay() + 7) % 7;
    day = addDays(now, diff);
  }
  if (!day || Number.isNaN(day.getTime())) return null;
  let hh = 23, mm = 59;
  if ((m = l.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/))) {
    hh = Number(m[1]) % 12 + (m[3] === "pm" ? 12 : 0);
    mm = Number(m[2] ?? 0);
  } else if ((m = l.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/))) { hh = Number(m[1]); mm = Number(m[2]); }
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(hh)}:${pad(mm)}`;
}

/** Remove date/time words so what's left is the title. */
export function stripDate(line: string): string {
  return line
    .replace(/\b(today|tonight|tomorrow)\b/gi, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/gi, " ")
    .replace(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, " ")
    .replace(/\b([01]?\d|2[0-3]):[0-5]\d\b/g, " ")
    .replace(/\s+(at|on|in room \w+|in \w+ \d+)\b(?=\s*$)/i, " ")
    .replace(/\s+/g, " ").trim();
}

const NOISE = /^(due|to do|todo|upcoming|assignments?|points?|pts|submitted|not submitted|missing|late|\d+\s*(pts|points)?)$/i;
const EVENT_WORDS = /\b(meeting|practice|rehearsal|tournament|banquet|game|club|competition|session|call|interview|concert|match)\b/i;

/** Rule-based extraction used when the in-browser LLM is off. */
export function extractItems(text: string, now: Date): Found[] {
  const lines = text
    .split(/\n+/)
    .flatMap((l) => l.split(/(?:!{2,}|;)\s*|\s+\balso\b\s+/i))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2);
  const out: Found[] = [];
  for (let i = 0; i < lines.length; i++) {
    const due = findDate(lines[i], now);
    if (!due) continue;
    let title = stripDate(lines[i].replace(/\b(due|by)\b.*$/i, "")).replace(/[•|·]+/g, " ").replace(/\s+(on|at|in)$/i, "").trim();
    if (title.length < 4 || NOISE.test(title) || findDate(title, now)) { // date on its own line: title is above
      const prev = lines[i - 1];
      title = prev && !findDate(prev, now) && !NOISE.test(prev) ? prev : "";
    }
    if (!title || out.some((o) => o.title === title)) continue;
    const course = lines[i - 2] && /^[A-Z][\w &/-]{2,40}$/.test(lines[i - 2]) && !findDate(lines[i - 2], now) ? lines[i - 2] : "";
    out.push({ title: title.slice(0, 120), course, due, kind: EVENT_WORDS.test(title) ? "event" : "task", minutes: null });
  }
  return out.slice(0, 12);
}

export function fileFromClipboard(e: ClipboardEvent): File | null {
  for (const it of e.clipboardData?.items ?? []) if (it.type.startsWith("image/")) return it.getAsFile();
  return null;
}

export const nowLocal = (): string => fmtLocal(new Date());
