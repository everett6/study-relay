import "./styles.css";
import type { Block, InboxItem, State, Task } from "./core/types";
import { SCHOOL } from "./core/types";
import { addDays, fmtDate, fmtLocal, hm12, parseLocal, startOfDay } from "./core/time";
import { fixedSpans, REVIEW } from "./core/schedule";
import { DEFAULT_TARGET, subjectFocus, type FocusLevel } from "./core/grades";
import { Store, api, httpTransport } from "./core/store";
import { fetchGrades, mergeTasks, proxyFetcher, syncCanvas, syncICS } from "./core/canvas";
import { LLMClient, MODELS, checkWebGPU, type LLMStatus } from "./ai/llmClient";
import { TASK_TYPE } from "./ai/heuristics";
import { CfCScheduler } from "./ai/cfcScheduler";
import { MODE_COPY, recentRecord } from "./ai/momentum";
import { Engine, uid, type Reply } from "./app/engine";
import { Voice, speechSupported } from "./app/voice";
import { extractItems, fileFromClipboard, readImage, type Found } from "./app/screenshot";
import { ICON, confetti, confirmSheet, h, ring, sheet, svg, toast } from "./app/dom";

type View = "today" | "week" | "tasks" | "inbox";

const store = new Store(httpTransport());
let llmStatus: LLMStatus;
const llm = new LLMClient((s) => { llmStatus = s; renderModelChip(); });
llmStatus = llm.status;
const engine = new Engine(store, llm);
const voice = new Voice();
let view: View = (location.hash.slice(1) as View) || "today";
if (!["today", "week", "tasks", "inbox"].includes(view)) view = "today";
let lastView: View | null = null;
let integrations: Record<string, unknown> = {};

const COLORS: Record<string, string> = { AIME: "violet", USAAIO: "blue", RESEARCH: "green", ACT: "orange", PHYSICS: "pink", [SCHOOL]: "teal" };
const color = (b: Pick<Block, "bucket">) => COLORS[b.bucket] ?? "teal";
const mins = (b: Block) => Math.round((parseLocal(b.end).getTime() - parseLocal(b.start).getTime()) / 60000);
const now = () => engine.clock();

// ------------------------------------------------------------------ shell
const app = document.getElementById("app")!;
app.append(
  h("header", { class: "top" },
    h("div", { class: "hello" }, h("div", { class: "greet", id: "greet" }), h("div", { class: "date", id: "date" })),
    h("div", { class: "top-actions" },
      h("span", { class: "sync-dot", id: "sync", title: "Sync status" }),
      h("button", { class: "chip model", id: "model-chip", onclick: openModelSheet }),
      h("button", { class: "icon-btn", "aria-label": "Settings", onclick: openSettings }, svg(ICON.gear)))),
  h("nav", { class: "tabs", "aria-label": "Views" },
    ...([["today", "Today", ICON.sun], ["week", "Week", ICON.week], ["tasks", "Tasks", ICON.tasks], ["inbox", "Inbox", ICON.inbox]] as const)
      .map(([k, label, ico]) => h("button", { class: "tab", type: "button", "data-view": k, "aria-label": label, onclick: () => go(k) }, svg(ico), h("span", null, label),
        k === "inbox" ? h("b", { class: "badge", id: "inbox-badge" }) : null))),
  h("main", { id: "view", tabindex: "-1" }),
  h("div", { class: "dock" },
    h("form", { class: "ask", onsubmit: (e: Event) => { e.preventDefault(); void ask(); } },
      h("button", { type: "button", class: "icon-btn", "aria-label": "Add a screenshot", title: "Screenshot (or paste one anywhere)", onclick: pickImage }, svg(ICON.camera)),
      h("input", { id: "ask", placeholder: "Ask or tell me anything… “banquet at 7 tonight”", autocomplete: "off", "aria-label": "Message" }),
      h("button", { type: "button", class: "icon-btn mic", "aria-label": "Voice mode", title: "Talk to it", onclick: openVoice }, svg(ICON.mic)),
      h("button", { type: "submit", class: "icon-btn send", "aria-label": "Send" }, svg(ICON.send)))),
  h("div", { id: "toasts", "aria-live": "polite" }),
  h("div", { id: "overlay" }),
  h("input", { type: "file", id: "file", accept: "image/*", hidden: true, onchange: (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0]; if (f) void handleImage(f); (e.target as HTMLInputElement).value = "";
  } }),
);

function go(v: View) { view = v; location.hash = v; render(); (document.getElementById("view") as HTMLElement).focus({ preventScroll: true }); scrollTo({ top: 0 }); }

// ------------------------------------------------------------------ render
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const main = document.getElementById("view")!;
    const active = document.activeElement;
    if (active && main.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName) && lastView === view) {
      active.addEventListener("blur", () => render(), { once: true });
      return; // don't yank the field out from under the user
    }
    const s = store.state;
    const t = now();
    const hr = t.getHours();
    document.getElementById("greet")!.textContent = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
    document.getElementById("date")!.textContent = t.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const dot = document.getElementById("sync")!;
    dot.className = `sync-dot ${store.status}`;
    dot.title = store.status === "synced" ? "Synced with relay" : store.status === "offline" ? `Offline: changes are saved and will sync (${store.lastError})` : "Syncing…";
    if (/\b401\b|bad relay token/.test(store.lastError)) {
      main.replaceChildren();
      if (!tokenHintShown) {
        tokenHintShown = true;
        openLoginSheet();
      }
      return;
    }
    const newCount = s.inbox.filter((i) => i.status === "new").length + s.drafts.filter((d) => d.status === "draft").length;
    const badge = document.getElementById("inbox-badge")!;
    badge.textContent = newCount ? String(newCount) : "";
    badge.hidden = !newCount;
    for (const b of document.querySelectorAll<HTMLElement>(".tab")) { b.classList.toggle("on", b.dataset.view === view); if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }
    const body = view === "today" ? Today(s) : view === "week" ? Week(s) : view === "tasks" ? Tasks(s) : Inbox(s);
    const wrap = h("div", { class: `page ${lastView !== view ? "enter" : ""}` }, body);
    main.replaceChildren(wrap);
    lastView = view;
    renderModelChip();
    renderFocus();
  });
}

function shortModelName(s?: string): string {
  if (!s) return "Smart AI on";
  const tail = s.split("/").pop() ?? s;
  return tail.replace(/:free$/, "").slice(0, 22);
}

function renderModelChip() {
  const c = document.getElementById("model-chip");
  if (!c) return;
  const st = llmStatus.state;
  c.className = `chip model ${st}`;
  c.title = st === "ready" ? `${llmStatus.provider ?? "AI"}: ${llmStatus.modelLabel ?? llmStatus.model ?? "ready"}` : llmStatus.text;
  c.replaceChildren(svg(ICON.spark), h("span", null,
    st === "ready" ? shortModelName(llmStatus.modelLabel ?? llmStatus.model)
      : st === "loading" ? `Loading ${Math.round(llmStatus.progress * 100)}%` : "Smart AI"));
}

// ------------------------------------------------------------------ Today
function Today(s: State) {
  const t = now();
  const m = s.momentum;
  const mode = m?.mode ?? "steady";
  const copy = MODE_COPY[mode];
  const rec = m ? recentRecord(m) : { hits: 0, total: 0 };
  const today = fmtDate(t);
  const blocks = s.blocks.filter((b) => b.date === today).sort((a, b) => a.start.localeCompare(b.start));
  const next = s.blocks.filter((b) => b.status === "planned" && parseLocal(b.end) > t).sort((a, b) => a.start.localeCompare(b.start))[0];
  const live = next && parseLocal(next.start) <= t;
  const fixed = fixedSpans(s.rules, startOfDay(t), s.events).filter((f) => f.kind !== "blackout" || f.title !== "Skipped block");
  // Only what's still ahead (plus what's already done today). Slipped blocks were re-planned, so they're noise here.
  const shown = blocks.filter((b) => b.status === "done" || (b.status === "planned" && parseLocal(b.end) > t));
  const items: { at: string; node: HTMLElement }[] = [];
  for (const b of shown) items.push({ at: b.start, node: BlockRow(b, next?.id === b.id) });
  for (const f of fixed) if (f.e > t && f.kind !== "break")
    items.push({ at: fmtLocal(f.s), node: h("li", { class: `fixed ${f.kind}` }, h("time", null, hm12(fmtLocal(f.s))), h("span", null, fixedLabel(f.kind, f.title))) });
  items.sort((a, b) => a.at.localeCompare(b.at));
  const goals = s.buckets.filter((b) => b.key !== SCHOOL && b.target_hours > 0);
  const missedToday = blocks.filter((b) => b.status === "missed").length;
  const left = shown.filter((b) => b.status === "planned").reduce((a, b) => a + mins(b), 0);
  const risks = s.meta.at_risk;

  return [
    h("section", { class: `card status ${mode}`, style: "--i:0", title: copy.line },
      h("span", { class: "status-ico", "aria-hidden": "true" }, svg(MODE_ICON[mode])),
      h("div", { class: "status-text" },
        h("b", null, copy.title),
        h("small", null, missedToday ? `${missedToday} block${missedToday > 1 ? "s" : ""} slipped today. I moved that work later.`
          : rec.total ? `${Number.isInteger(rec.hits) ? rec.hits : rec.hits.toFixed(1)} of your last ${rec.total} blocks done` : copy.line)),
      h("div", { class: "mood", role: "group", "aria-label": "How are you feeling?" },
        ...["😫", "😕", "🙂", "😊", "🤩"].map((e, i) => h("button", { class: "emoji", title: ["Rough", "Meh", "Okay", "Good", "Great"][i], "aria-label": `Feeling ${["rough", "meh", "okay", "good", "great"][i]}`,
          onclick: () => { engine.checkIn(i + 1); toast(i < 2 ? "Thanks. I lightened things up a bit." : "Nice! Keeping the plan rolling.", "ok"); } }, e)))),
    AttentionCard(s, 3),
    next ? h("section", { class: `card next ${color(next)}`, style: "--i:1" },
      h("div", { class: "next-meta" }, h("span", { class: "pill" }, live ? "Now" : `Up next · ${relTime(parseLocal(next.start), t)}`),
        h("span", { class: "muted" }, `${hm12(next.start)} – ${hm12(next.end)} · ${mins(next)} min`)),
      h("h2", null, next.title),
      h("div", { class: "row" },
        h("button", { class: "btn primary big", onclick: () => engine.timerStart({ blockId: next.id }) }, svg(ICON.play), "Start focus"),
        h("button", { class: "btn ghost", onclick: () => openBlock(next) }, "Change"))) :
      h("section", { class: "card next empty", style: "--i:1" }, h("h2", null, "Nothing else planned today"), h("p", { class: "muted" }, "Enjoy the free time, or tell me what's coming up.")),
    risks.length ? h("section", { class: "card risk", style: "--i:2" },
      h("b", null, "Heads up: "),
      h("span", null, risks.slice(0, 2).map((r) => `${r.title} (${r.minutes} min short)`).join(" · ")),
      risks.length > 2 ? h("span", { class: "muted" }, ` and ${risks.length - 2} more`) : null) : null,
    h("section", { class: "card", style: "--i:3" },
      h("div", { class: "card-head" }, h("h3", null, "Rest of today"),
        h("div", { class: "row" },
          h("span", { class: "muted" }, left ? `${fmtMins(left)} of work left` : "All done"),
          h("button", { class: "btn ghost sm", onclick: openDailyReview }, "Daily review"))),
      items.length ? h("ol", { class: "timeline" }, items.map((x) => x.node)) : h("p", { class: "muted" }, "Nothing left on today's plan.")),
    goals.length ? h("section", { class: "card", style: "--i:4" },
      h("div", { class: "card-head" }, h("h3", null, "This week's goals"), h("button", { class: "link", onclick: openSettings }, "Edit")),
      h("div", { class: "goals" }, goals.map((b) => {
        const f = Math.min(1, b.logged_minutes / (b.target_hours * 60));
        return h("div", { class: `goal ${COLORS[b.key] ?? "teal"}` },
          h("span", null, bucketShort(b.key)),
          h("div", { class: "bar", role: "img", "aria-label": `${Math.round(f * 100)}% of goal` }, h("i", { style: `width:${Math.round(f * 100)}%` })),
          h("small", null, `${(b.logged_minutes / 60).toFixed(1)}/${b.target_hours}h`));
      }))) : null,
  ];
}

const BUCKET_SHORT: Record<string, string> = { RESEARCH: "Research", PHYSICS: "Physics", [SCHOOL]: "School" };
const bucketShort = (k: string) => BUCKET_SHORT[k] ?? k;
const fmtMins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`);
/** Short label for small spaces: the bucket name, or the course without "/AP…" plus the assignment. */
function shortTitle(b: Block, courseOnly = false): string {
  if (b.kind === "bucket") return b.title.startsWith(REVIEW) ? (courseOnly ? `Review ${b.title.slice(REVIEW.length).split(/[/(]/)[0]}` : b.title) : bucketShort(b.bucket);
  const k = b.title.indexOf(": ");
  if (k < 0) return b.title;
  const course = b.title.slice(0, k).split(/[/(]/)[0].trim();
  return courseOnly ? course : `${course} · ${b.title.slice(k + 2)}`;
}

const MODE_ICON: Record<keyof typeof MODE_COPY, string> = { thriving: ICON.rocket, steady: ICON.waves, stretched: ICON.cloudSun, overloaded: ICON.heart };

function fixedLabel(kind: string, title: string): (HTMLElement | string)[] {
  const m: Record<string, [string, string]> = { school: [ICON.school, "School"], break: [ICON.cup, "Break"], dinner: [ICON.utensils, "Dinner"],
    sleep: [ICON.moon, "Wind down & sleep"], event: [ICON.ticket, title] };
  const [ico, text] = m[kind] ?? (title.startsWith("Get ready") ? [ICON.shirt, title] : ["", title]);
  return ico ? [svg(ico), text] : [text];
}

function relTime(d: Date, t: Date) {
  const m = Math.round((d.getTime() - t.getTime()) / 60000);
  if (m < 60) return `in ${m} min`;
  if (fmtDate(d) === fmtDate(t)) return `at ${hm12(fmtLocal(d))}`;
  if (fmtDate(d) === fmtDate(addDays(t, 1))) return `tomorrow ${hm12(fmtLocal(d))}`;
  return d.toLocaleDateString("en-US", { weekday: "short" }) + " " + hm12(fmtLocal(d));
}

function BlockRow(b: Block, isNext = false) {
  return h("li", { class: `blk ${color(b)} ${b.status} ${isNext ? "is-next" : ""}`, tabindex: "0", title: b.title, onclick: () => openBlock(b), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") openBlock(b); } },
    h("time", null, hm12(b.start)),
    h("div", { class: "blk-body" },
      h("b", null, shortTitle(b)),
      h("small", null, `${mins(b)} min${b.locked ? " · kept" : ""}`)),
    b.status === "done" ? h("span", { class: "tick" }, svg(ICON.check)) : null);
}

function openBlock(b: Block) {
  const date = h("input", { type: "date", value: b.date });
  const time = h("input", { type: "time", value: b.start.slice(11), step: "300" });
  const close = sheet(b.title, h("div", { class: "stack" },
    h("p", { class: "muted" }, `${new Date(b.date + "T00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} · ${hm12(b.start)}–${hm12(b.end)} · ${mins(b)} min`),
    b.status === "planned" ? h("button", { class: "btn primary big", onclick: () => { close(); engine.timerStart({ blockId: b.id }); } }, svg(ICON.play), "Start focus now") : null,
    h("div", { class: "field-row" }, h("label", null, "Move to", date), h("label", null, "at", time)),
    h("div", { class: "row end" },
      h("button", { class: "btn ghost danger", onclick: () => { close(); engine.removeBlock(b.id); toast("Removed. The plan adjusted around it.", "ok"); } }, svg(ICON.trash), "Skip"),
      h("button", { class: "btn", onclick: () => {
        const err = engine.moveBlock(b.id, date.value, time.value);
        if (err) toast(err, "warn"); else { close(); toast("Moved and pinned.", "ok"); }
      } }, "Move"))));
}

// ------------------------------------------------------------------ Week (drag and drop)
const DAY_START = 7 * 60, DAY_END = 23 * 60, PX = 0.75;
let selectedWeekDay = "";
function Week(s: State) {
  const t = now();
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(t), i));
  const dayKeys = days.map(fmtDate);
  if (!dayKeys.includes(selectedWeekDay)) selectedWeekDay = dayKeys[0];
  const selectedDay = days.find((d) => fmtDate(d) === selectedWeekDay)!;
  const selectedFixed = fixedSpans(s.rules, selectedDay, s.events).filter((f) => f.kind !== "break");
  const selectedBlocks = s.blocks.filter((b) => b.date === selectedWeekDay && b.status !== "missed");
  const daySummary = (key: string) => {
    const blocks = s.blocks.filter((b) => b.date === key);
    const planned = blocks.filter((b) => b.status === "planned").reduce((sum, b) => sum + mins(b), 0);
    const done = blocks.filter((b) => b.status === "done").reduce((sum, b) => sum + mins(b), 0);
    return [
      planned ? `${fmtMins(planned)} planned` : "",
      done ? `${fmtMins(done)} done` : "",
    ].filter(Boolean).join(" · ");
  };
  const selectDay = (index: number) => {
    const key = dayKeys[index];
    selectedWeekDay = key;
    render();
    requestAnimationFrame(() => document.getElementById(`week-day-${key}`)?.focus());
  };
  const agenda: { start: Date; end: Date; title: string; kind: string; block?: Block }[] = [
    ...selectedFixed.map((f) => ({ start: f.s, end: f.e, title: f.title, kind: `fixed ${f.kind}` })),
    ...selectedBlocks.map((b) => ({ start: parseLocal(b.start), end: parseLocal(b.end), title: b.title,
      kind: `${color(b)} ${b.status}`, block: b })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime());
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START / 60 + i);
  return [
    h("div", { class: "card-head pad" }, h("h1", null, "Next 7 days"), h("span", { class: "muted" }, "Move a block to change the plan")),
    h("section", { class: "week-mobile card", "aria-label": "Daily schedule" },
      h("div", { class: "week-day-picker", role: "tablist", "aria-label": "Choose a day" },
        ...days.map((d, i) => {
          const key = fmtDate(d);
          const active = key === selectedWeekDay;
          return h("button", { class: `week-day-choice ${active ? "on" : ""}`, type: "button", role: "tab",
            id: `week-day-${key}`, "aria-controls": "week-day-panel", "aria-selected": String(active),
            tabindex: active ? "0" : "-1", onclick: () => selectDay(i),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === "ArrowRight") { e.preventDefault(); selectDay((i + 1) % days.length); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); selectDay((i + days.length - 1) % days.length); }
              else if (e.key === "Home") { e.preventDefault(); selectDay(0); }
              else if (e.key === "End") { e.preventDefault(); selectDay(days.length - 1); }
            } },
            h("small", null, d.toLocaleDateString("en-US", { weekday: "short" })),
            h("b", null, String(d.getDate())));
        })),
      h("div", { id: "week-day-panel", role: "tabpanel", tabindex: "0", "aria-labelledby": `week-day-${selectedWeekDay}` },
        h("div", { class: "agenda-date" },
          h("h2", null, selectedDay.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })),
          h("span", { class: "muted small" }, daySummary(selectedWeekDay) || "No study blocks")),
        agenda.length
          ? h("ol", { class: "agenda-list" }, ...agenda.map((item) => {
            const block = item.block;
            const content = h("div", { class: "agenda-entry" },
              h("b", null, item.title),
              h("span", { class: "agenda-duration" }, block
                ? `${block.status === "done" ? "Done · " : ""}${mins(block)} min`
                : `until ${hm12(fmtLocal(item.end))}`));
            return h("li", { class: `agenda-item ${item.kind}` },
              h("time", null, hm12(fmtLocal(item.start))),
              block
                ? h("button", { class: "agenda-button", type: "button", onclick: () => openBlock(block) }, content)
                : content);
          }))
          : h("div", { class: "agenda-empty" }, h("b", null, "A clear day"), h("p", { class: "muted small" }, "No blocks planned. Keep the free time or add a task.")))),
    h("div", { class: "week card", style: "--i:0" },
      h("div", { class: "hours" }, hours.map((x) => h("span", { style: `top:${(x * 60 - DAY_START) * PX}px` }, `${x % 12 || 12}${x < 12 ? "a" : "p"}`))),
      ...days.map((d, i) => {
        const key = fmtDate(d);
        const col = h("div", { class: `day ${i === 0 ? "today" : ""}`, "data-date": key, style: `--i:${i}` },
          h("div", { class: "day-head" }, h("b", null, `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()}`),
            h("small", null, daySummary(key) || "free")),
          h("div", { class: "day-body", style: `height:${(DAY_END - DAY_START) * PX}px` },
            ...fixedSpans(s.rules, d, s.events).filter((f) => f.kind !== "break").map((f) => {
              const a = Math.max(DAY_START, f.s.getHours() * 60 + f.s.getMinutes()), z = Math.min(DAY_END, f.e.getDate() !== f.s.getDate() ? DAY_END : f.e.getHours() * 60 + f.e.getMinutes());
              const label = f.kind === "school" || f.kind === "event" ? fixedLabel(f.kind, f.title).filter((x) => typeof x === "string") : "";
              return z > a ? h("div", { class: `span ${f.kind}`, title: f.title, style: `top:${(a - DAY_START) * PX}px;height:${(z - a) * PX}px` }, z - a > 40 ? label : "") : null;
            }),
            ...s.blocks.filter((b) => b.date === key && b.status !== "missed").map((b) => {
              const st = parseLocal(b.start), a = st.getHours() * 60 + st.getMinutes();
              const el = h("div", { class: `wblk ${color(b)} ${b.status}`, draggable: b.status === "planned" ? "true" : "false", "data-id": b.id,
                style: `top:${(a - DAY_START) * PX}px;height:${Math.max(18, mins(b) * PX - 2)}px`, title: `${b.title} · ${hm12(b.start)}`,
                onclick: () => openBlock(b) }, h("b", null, shortTitle(b, true)), mins(b) >= 40 ? h("small", null, `${mins(b)} min`) : null);
              el.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("text/plain", b.id); e.dataTransfer!.effectAllowed = "move"; el.classList.add("dragging"); });
              el.addEventListener("dragend", () => el.classList.remove("dragging"));
              return el;
            })));
        const bodyEl = col.querySelector(".day-body") as HTMLElement;
        bodyEl.addEventListener("dragover", (e) => { e.preventDefault(); bodyEl.classList.add("over"); });
        bodyEl.addEventListener("dragleave", () => bodyEl.classList.remove("over"));
        bodyEl.addEventListener("drop", (e) => {
          e.preventDefault();
          bodyEl.classList.remove("over");
          const id = e.dataTransfer!.getData("text/plain");
          const y = e.clientY - bodyEl.getBoundingClientRect().top;
          const m = Math.round((DAY_START + y / PX) / 15) * 15;
          const err = engine.moveBlock(id, key, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
          toast(err ?? "Moved and pinned. Everything else re-planned.", err ? "warn" : "ok");
        });
        return col;
      })),
  ];
}

function estimationInsights(s: State): HTMLElement | null {
  if (s.sessions.length < 2) return null;
  const byType = new Map<string, { planned: number; actual: number; n: number }>();
  const taskMap = new Map(s.tasks.map((t) => [t.id, t]));
  for (const se of s.sessions) {
    if (se.planned_min <= 0 || se.actual_min <= 0) continue;
    const t = se.task_id ? taskMap.get(se.task_id) : undefined;
    const key = t?.task_type ?? "Goal";
    const cur = byType.get(key) ?? { planned: 0, actual: 0, n: 0 };
    cur.planned += se.planned_min;
    cur.actual += se.actual_min;
    cur.n++;
    byType.set(key, cur);
  }
  const rows = [...byType.entries()].filter(([, v]) => v.n >= 1).map(([k, v]) => {
    const ratio = v.actual / v.planned;
    const pct = Math.round((ratio - 1) * 100);
    const label = Math.abs(pct) <= 8 ? "on target" : pct > 0 ? `${pct}% longer` : `${Math.abs(pct)}% faster`;
    return h("span", { class: `pill ${pct > 15 ? "warm" : ""}` }, `${k}: ${ratio.toFixed(2)}× (${label}, ${v.n})`);
  });
  return rows.length ? h("section", { class: "card", style: "--i:1" },
    h("div", { class: "card-head" }, h("h3", null, "Your personal estimate accuracy"), h("span", { class: "muted small" }, "Actual vs. planned across logged sessions")),
    h("div", { class: "chips" }, rows)) : null;
}

const needsDueCheck = (t: Task): boolean =>
  t.source !== "manual" && (!t.due_at || t.due_at.endsWith("23:59"));

function openDailyReview() {
  const s = store.state;
  const today = fmtDate(now());
  const checkTasks = s.tasks.filter((t) => t.status === "open" && needsDueCheck(t)).slice(0, 6);
  const todayBlocks = s.blocks.filter((b) => b.date === today && b.status === "planned").sort((a, b) => a.start.localeCompare(b.start));
  const close = sheet("Daily 30-second review", h("div", { class: "stack" },
    h("h3", null, "1. Imported deadlines to verify"),
    checkTasks.length
      ? h("div", { class: "stack tight" }, checkTasks.map((t) =>
          h("div", { class: "row", style: "justify-content:space-between" },
            h("span", { class: "small" }, h("strong", null, t.course || "Task"), `: ${t.title} `, h("span", { class: "muted" }, t.due_at ? `(${t.due_at.replace("T", " ")})` : "(no due date)")),
            h("div", { class: "row" },
              h("button", { class: "btn ghost sm", onclick: () => { engine.correctEstimate(t.id, (t.human_minutes ?? t.estimated_minutes) + 15); close(); openDailyReview(); } }, "+15m"),
              h("button", { class: "btn ghost sm ok", onclick: () => { engine.markDone(t.id); close(); openDailyReview(); } }, "Done")))))
      : h("p", { class: "muted small" }, "All open deadlines look verified."),
    h("h3", null, "2. Today's planned blocks"),
    todayBlocks.length
      ? h("div", { class: "stack tight" }, todayBlocks.map((b) =>
          h("div", { class: "row", style: "justify-content:space-between" },
            h("span", { class: "small" }, `${hm12(b.start)}–${hm12(b.end)} · `, h("strong", null, b.title)),
            h("button", { class: "btn ghost sm danger", onclick: () => { engine.removeBlock(b.id); close(); openDailyReview(); } }, "Drop"))))
      : h("p", { class: "muted small" }, "No study blocks remaining today."),
    h("div", { class: "row end" },
      h("button", { class: "btn ghost", onclick: () => { close(); openAddTask(); } }, "Add task"),
      h("button", { class: "btn primary", onclick: () => { close(); toast("Today's plan accepted.", "ok"); } }, "Accept today's plan")),
  ));
}

// ------------------------------------------------------------------ Tasks (estimation matrix)
function Tasks(s: State) {
  const t0 = now();
  const open = s.tasks.filter((t) => t.status === "open").sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9"));
  const done = s.tasks.filter((t) => t.status === "done").slice(-5);
  const soon = addDays(t0, 2), week = addDays(startOfDay(t0), 7);
  const groups: [string, Task[]][] = [
    ["Overdue", open.filter((t) => t.due_at && parseLocal(t.due_at) < t0)],
    ["Next 2 days", open.filter((t) => t.due_at && parseLocal(t.due_at) >= t0 && parseLocal(t.due_at) < soon)],
    ["This week", open.filter((t) => t.due_at && parseLocal(t.due_at) >= soon && parseLocal(t.due_at) < week)],
    ["Later", open.filter((t) => !t.due_at || parseLocal(t.due_at) >= week)],
  ];
  const totalMin = open.reduce((a, t) => a + Math.max(0, (t.human_minutes ?? t.estimated_minutes) - t.logged_minutes), 0);
  const lastSync = s.meta.last_canvas_sync;
  const staleHours = lastSync ? (t0.getTime() - parseLocal(lastSync).getTime()) / 3600000 : Infinity;
  const staleSync = staleHours > 24;
  const seenKeys = new Set<string>();
  const cutoff14 = addDays(t0, -14).getTime();
  const hasCleanup = open.some((t) => {
    const k = `${t.course.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`;
    if (seenKeys.has(k)) return true;
    seenKeys.add(k);
    return t.source !== "manual" && !!t.due_at && parseLocal(t.due_at).getTime() < cutoff14;
  });
  return [
    h("div", { class: "card-head pad" },
      h("div", null, h("h1", null, "Tasks"), h("small", { class: "muted" }, open.length ? `${open.length} open · about ${fmtMins(Math.round(totalMin / 5) * 5)} of work` : "")),
      h("div", { class: "row wrap" },
        hasCleanup ? h("button", { class: "btn ghost sm", onclick: () => { const n = engine.cleanupImportedTasks(); toast(n ? `Cleaned up ${n} duplicate/old task(s).` : "Nothing to clean up.", "ok"); } }, "Clean up") : null,
        h("button", { class: "btn ghost sm", onclick: (e: Event) => void doCanvasSync(e.currentTarget as HTMLButtonElement) }, svg(ICON.sync), "Sync Canvas"),
        h("button", { class: "btn ghost sm", onclick: openAddTask }, svg(ICON.plus), "Add"))),
    staleSync && open.some((t) => t.source === "canvas") ? h("section", { class: "card risk", style: "--i:0" },
      h("b", null, "Canvas sync is stale: "),
      h("span", null, lastSync ? `last synced ${ago(lastSync)}. ` : "not synced recently. "),
      h("button", { class: "link", onclick: () => void doCanvasSync() }, "Sync now")) : null,
    AttentionCard(s),
    open.length ? h("section", { class: "card tasklist", style: "--i:1" },
      ...groups.filter(([, list]) => list.length).map(([label, list]) => h("div", { class: "tgroup" },
        h("h4", { class: label === "Overdue" ? "late" : "" }, label, h("span", null, String(list.length))),
        h("ul", null, list.map((t) => TaskRow(t)))))) :
      h("section", { class: "card empty", style: "--i:1" }, h("h2", null, "All clear"), h("p", { class: "muted" }, "Sync Canvas to pull in assignments, or add one.")),
    GradesCard(s),
    estimationInsights(s),
    done.length ? h("details", { class: "card done-list", style: "--i:3" }, h("summary", null, `Recently done (${done.length})`),
      h("ul", null, done.map((t) => h("li", null, h("span", null, svg(ICON.check), t.title), h("button", { class: "link", onclick: () => engine.markDone(t.id, false) }, "Undo"))))) : null,
  ];
}

// ------------------------------------------------------------------ zeros & missing work
function AttentionCard(s: State, max = 6) {
  const flags = (s.flags ?? []).filter((f) => f.status !== "dismissed")
    .sort((a, b) => Number(a.status === "planned") - Number(b.status === "planned") || b.points - a.points);
  if (!flags.length) return null;
  const pts = flags.reduce((a, f) => a + f.points - (f.score ?? 0), 0);
  return h("section", { class: "card attention", style: "--i:0" },
    h("div", { class: "card-head" }, h("h3", null, svg(ICON.x), "Needs attention"),
      h("span", { class: "muted small" }, `${flags.length} item${flags.length > 1 ? "s" : ""} · ${Math.round(pts)} pts at stake`)),
    h("ul", { class: "flag-list" }, flags.slice(0, max).map((f) => h("li", { class: `flag ${f.kind} ${f.status}` },
      h("div", { class: "flag-main" },
        h("b", null, f.title),
        h("small", null, `${f.course} · ${f.kind === "zero" ? `graded 0/${f.points}` : `not turned in · ${f.points} pts`}${f.due_at ? ` · was due ${new Date(f.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`,
          f.status === "planned" ? h("span", { class: "planned" }, " · make-up planned") : !f.can_submit ? " · closed on Canvas" : "")),
      h("div", { class: "flag-actions" },
        f.status === "planned" ? h("button", { class: "btn ghost sm", title: "Take the make-up time off the plan", onclick: () => engine.unplanMakeup(f.id) }, "Undo") : h("button", { class: "btn sm", onclick: () => { engine.planMakeup(f.id); toast(`Planned make-up time for “${f.title}” in the next two days.`, "ok"); } }, "Plan make-up"),
        h("button", { class: "btn ghost sm", title: "Write a draft to your teacher (nothing is sent)", onclick: () => { if (engine.draftTeacherEmail(f.id)) { view = "inbox"; inboxTab = "drafts"; lastView = null; render(); toast("Draft ready in Inbox → Drafts. Add your teacher's email, then send it yourself.", "ok"); } } }, "Email teacher"),
        h("button", { class: "icon-btn sm", "aria-label": `Dismiss ${f.title}`, title: "Dismiss (excused or can't be made up)", onclick: () => engine.dismissFlag(f.id) }, svg(ICON.x)))))),
    flags.length > max ? h("p", { class: "muted small" }, `and ${flags.length - max} more`) : null);
}

// ------------------------------------------------------------------ task rows
const COURSE_COLORS = ["violet", "blue", "green", "orange", "pink", "teal"];
const courseColor = (c: string) => { let x = 0; for (const ch of c) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return COURSE_COLORS[x % COURSE_COLORS.length]; };
let openTaskId: string | null = null;
function dueText(due: Date, t: Date): string {
  const d = Math.round((startOfDay(due).getTime() - startOfDay(t).getTime()) / 86400000);
  const time = hm12(fmtLocal(due));
  if (d < 0) return `${-d} day${d < -1 ? "s" : ""} overdue`;
  if (d === 0) return `today ${time}`;
  if (d === 1) return `tomorrow ${time}`;
  return `${due.toLocaleDateString("en-US", { weekday: "short", month: d > 6 ? "short" : undefined, day: d > 6 ? "numeric" : undefined })} ${time}`;
}
function TaskRow(t: Task) {
  const est = t.human_minutes ?? t.estimated_minutes;
  const due = t.due_at ? parseLocal(t.due_at) : null;
  const hrs = due ? (due.getTime() - now().getTime()) / 3600000 : Infinity;
  const isOpen = openTaskId === t.id;
  const flagged = t.source === "makeup";
  const desc = (t.description ?? "").replace(/\n?Submit: [^\n]*/g, "").trim();
  const submit = (t.description ?? "").match(/Submit: ([^\n]+)/)?.[1];
  const toggle = () => { openTaskId = isOpen ? null : t.id; render(); };
  const row = h("li", { class: `trow ${courseColor(t.course || "x")} ${isOpen ? "open" : ""} ${flagged ? "makeup" : ""}` },
    h("div", { class: "trow-main", role: "button", tabindex: "0", "aria-expanded": String(isOpen), onclick: toggle, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } } },
      h("div", { class: "trow-text" },
        h("b", null, t.title),
        h("small", null, [t.course || "Personal", TASK_TYPE[t.category] ?? t.task_type, submit].filter(Boolean).join(" · "),
          due ? h("span", { class: `due ${hrs < 0 ? "late" : hrs < 24 ? "soon" : ""}` }, ` · ${dueText(due, now())}`) : null,
          needsDueCheck(t) ? h("span", { class: "pill warm", style: "margin-left:6px", title: "Imported deadline — verify due time" }, "Check due") : null)),
      h("span", { class: "trow-min", title: t.est_source === "human" ? "your estimate" : "estimated" }, est ? fmtMins(est) : "—")),
    h("button", { class: "icon-btn sm done-btn", "aria-label": `Mark ${t.title} done`, title: "Done", onclick: () => { engine.markDone(t.id); confetti(); } }, svg(ICON.check)));
  if (isOpen) row.append(TaskDetail(t, est, desc));
  return row;
}
function TaskDetail(t: Task, est: number, desc: string) {
  const input = h("input", { type: "number", min: "5", max: "1200", step: "5", value: est || "", "aria-label": "Minutes", class: "mins",
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (v >= 5 && v <= 1200 && v !== est) engine.correctEstimate(t.id, v);
    } });
  const step = (d: number) => { const v = Math.max(5, (Number(input.value) || est) + d); input.value = String(v); input.dispatchEvent(new Event("change")); };
  return h("div", { class: "trow-detail" },
    desc ? h("p", { class: "desc" }, desc.length > 320 ? desc.slice(0, 320) + "…" : desc) : null,
    t.est_why ? h("p", { class: "muted small" }, `Why ${est} min: ${t.est_why}`) : null,
    h("div", { class: "detail-grid" },
      h("div", null, h("small", { class: "lbl" }, t.est_source === "human" ? "Your estimate" : `Estimate · ${t.est_source === "llm" ? "AI" : "quick"} guess`),
        h("div", { class: "stepper" }, h("button", { class: "icon-btn sm", "aria-label": "Less", onclick: () => step(-5) }, "−"), input,
          h("span", { class: "unit" }, "min"), h("button", { class: "icon-btn sm", "aria-label": "More", onclick: () => step(5) }, "+"))),
      h("div", null, h("small", { class: "lbl" }, "Difficulty"),
        h("div", { class: "seg", role: "radiogroup", "aria-label": "Difficulty" }, [1, 2, 3, 4, 5].map((n) =>
          h("button", { class: n === t.cognitive_load ? "on" : "", role: "radio", "aria-checked": String(n === t.cognitive_load), title: ["Easy", "Light", "Normal", "Hard", "Very hard"][n - 1], onclick: () => engine.setTaskLoad(t.id, n) }, String(n)))))),
    h("div", { class: "row" },
      h("button", { class: "btn primary sm", onclick: () => engine.timerStart({ taskId: t.id, bucket: SCHOOL }) }, svg(ICON.play), "Focus now"),
      h("button", { class: "btn ghost sm", onclick: () => { engine.markDone(t.id); confetti(); } }, svg(ICON.check), "Done")));
}

// ------------------------------------------------------------------ Grades & subject focus
const LEVEL_TEXT: Record<FocusLevel, string> = { focus: "Needs focus", watch: "Keep an eye on", improving: "Improving", ok: "On track" };
function ago(stamp: string): string {
  if (!stamp) return "";
  const m = Math.round((now().getTime() - parseLocal(stamp).getTime()) / 60000);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function GradesCard(s: State) {
  const grades = s.grades ?? [];
  if (!grades.length) return null;
  const focus = subjectFocus(s, now());
  const ignored = grades.filter((g) => g.ignore || g.score == null);
  const last = grades.reduce((m, g) => (g.updated > m ? g.updated : m), "");
  const weekly = focus.reduce((a, f) => a + f.reviewMin, 0);
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - 60) / 45) * 100)); // 60%..105% across the bar
  return h("section", { class: "card grades", style: "--i:2" },
    h("div", { class: "card-head" }, h("h3", null, "Grades"),
      h("span", { class: "muted small" }, weekly ? `+${fmtMins(weekly)} review/week · ` : "", `updated ${ago(last)} · `,
        h("button", { class: "link", onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.textContent = "Refreshing…"; await refreshGrades(true); toast("Grades refreshed. The plan follows them.", "ok"); render(); } }, "Refresh"))),
    h("ul", { class: "grade-list" },
      ...focus.map((f) => h("li", { class: `grade-row ${f.level}`, tabindex: "0", title: `${f.reason}. Tap to set a goal.`, onclick: () => openGrade(f.course), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") openGrade(f.course); } },
        h("span", { class: "g-name" }, f.course),
        h("div", { class: "g-bar", role: "img", "aria-label": `${f.score}% of a ${f.target}% goal` },
          h("i", { style: `width:${pct(f.score)}%` }), h("span", { class: "g-goal", style: `left:${pct(f.target)}%` })),
        h("span", { class: "g-score" }, `${f.score}%`, f.trend ? h("small", { class: f.trend > 0 ? "up" : "down" }, ` ${f.trend > 0 ? "▲" : "▼"}${Math.abs(f.trend)}`) : null),
        f.level === "focus" || f.level === "watch" ? h("small", { class: "g-note" }, `${LEVEL_TEXT[f.level]}: ${f.reason}${f.reviewMin ? ` · +${f.reviewMin} min review/week` : ""}`) : null)),
      ...ignored.map((g) => h("li", { class: "grade-row off", tabindex: "0", onclick: () => openGrade(g.course) },
        h("span", { class: "g-name" }, g.course), h("span", { class: "g-bar empty" }), h("span", { class: "g-score" }, g.ignore ? "skipped" : "—")))));
}

function openGrade(course: string) {
  const g = store.state.grades?.find((x) => x.course === course);
  if (!g) return;
  const f = subjectFocus(store.state, now()).find((x) => x.course === course);
  const target = h("input", { type: "number", min: "50", max: "110", step: "1", value: String(g.target ?? DEFAULT_TARGET), "aria-label": "Goal percent" });
  const ignore = h("input", { type: "checkbox", checked: !!g.ignore });
  const hist = g.history.slice(-8).map((p) => `${p.date.slice(5)}: ${p.score}%`).join(" · ");
  const close = sheet(course, h("div", { class: "stack" },
    h("p", null, g.score == null ? "No grade yet." : `Now ${g.score}%${g.grade ? ` (${g.grade})` : ""}. ${f ? f.reason.charAt(0).toUpperCase() + f.reason.slice(1) + "." : ""}`),
    hist ? h("p", { class: "muted small" }, `History: ${hist}`) : null,
    h("div", { class: "row" }, ...[["A", 93], ["A-", 90], ["B+", 87]].map(([l, v]) => h("button", { class: "btn ghost sm", type: "button", onclick: () => { target.value = String(v); } }, `${l} (${v}%)`))),
    h("label", null, "Goal (%)", target),
    h("label", { class: "check" }, ignore, " Leave this class out of planning"),
    h("p", { class: "muted small" }, "Below-goal or slipping classes get extra weekly review blocks and more time on their homework."),
    h("div", { class: "row end" }, h("button", { class: "btn primary", onclick: () => {
      engine.setGradeIgnore(course, ignore.checked);
      const v = Number(target.value);
      const r = engine.setGradeTarget(course, v >= 50 && v <= 110 && v !== DEFAULT_TARGET ? v : null);
      close(); toast(ignore.checked ? `${course} is left out of planning.` : r.text, "ok");
    } }, "Save"))));
}

/** Quietly pull grades (one Canvas request) when the saved ones are over 6 hours old. */
async function refreshGrades(force = false) {
  if (!integrations.canvas_server_token && !force) return;
  const last = (store.state.grades ?? []).reduce((m, g) => (g.updated > m ? g.updated : m), "");
  if (!force && last && now().getTime() - parseLocal(last).getTime() < 6 * 3600000) return;
  if (!force && store.state.tasks.length) { await doCanvasSync(); return; } // stale: full sync also refreshes zeros/missing
  try { engine.updateGrades(await fetchGrades(proxyFetcher()), now()); } catch { /* offline or no Canvas: keep the saved grades */ }
}

async function doCanvasSync(btn?: HTMLButtonElement) {
  btn?.classList.add("spin");
  try {
    const t = now();
    const ics = localStorage.getItem("ics_url");
    let incoming: Task[];
    let flagNote = "";
    try {
      const r = await syncCanvas(proxyFetcher(), t); incoming = r.tasks; engine.updateGrades(r.grades, t);
      if (r.flags) { const f = engine.updateFlags(r.flags, t); if (f.added) flagNote = ` Found ${f.added} zero/missing item${f.added > 1 ? "s" : ""}${f.planned ? `, planned make-up time for ${f.planned}` : ""}.`; }
    }
    catch (e) { if (!ics) throw e; incoming = await syncICS(proxyFetcher(), ics, t); }
    const r = mergeTasks(store.state.tasks, incoming);
    store.update((st) => { st.tasks = r.tasks; st.meta.last_canvas_sync = fmtLocal(t); });
    toast(`Canvas synced: ${incoming.length} open assignments, ${r.added} new.${flagNote}`, flagNote ? "warn" : "ok");
    await engine.estimateMissing();
  } catch (e) {
    toast(`Canvas sync failed: ${(e as Error).message}`, "warn");
  } finally { btn?.classList.remove("spin"); }
}

function openAddTask() {
  const title = h("input", { placeholder: "e.g. Physics lab report" });
  const course = h("input", { placeholder: "e.g. AP Physics C" });
  const due = h("input", { type: "datetime-local", value: fmtLocal(addDays(now(), 2)).slice(0, 11) + "23:59" });
  const close = sheet("Add a task", h("form", { class: "stack", onsubmit: (e: Event) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    engine.addTasks([newTask(title.value.trim(), course.value.trim(), due.value || null, "manual")]);
    close(); toast("Added. Estimating how long it'll take…", "ok");
  } }, h("label", null, "Title", title), h("label", null, "Course (optional)", course), h("label", null, "Due", due), h("button", { class: "btn primary", type: "submit" }, "Add task")));
}

function newTask(title: string, course: string, due: string | null, source: string, minutes?: number | null): Task {
  const lower = title.toLowerCase();
  const category = /\b(test|exam|midterm|final)\b/.test(lower) ? "test" : /\bquiz\b/.test(lower) ? "quiz" : /\blab\b/.test(lower) ? "lab"
    : /\b(project|essay|paper|presentation)\b/.test(lower) ? "project" : "homework";
  return { id: `${source}-${uid()}`, source, course, title, category, task_type: TASK_TYPE[category], due_at: due ?? undefined,
    cognitive_load: 3, llm_minutes: 0, estimated_minutes: 0, human_minutes: minutes ?? null, confidence: 0, recommended_45m_blocks: [],
    est_source: minutes ? "human" : "heuristic", logged_minutes: 0, status: "open" };
}

// ------------------------------------------------------------------ Inbox
let inboxTab: "new" | "drafts" | "all" = "new";
function Inbox(s: State) {
  const items = [...s.inbox].reverse().filter((i) => inboxTab === "all" ? true : i.status === "new");
  const drafts = [...s.drafts].reverse();
  const st = integrations as Record<string, boolean | Record<string, string> | string>;
  const chip = (on: unknown, label: string) => h("button", { type: "button", class: `chip ${on ? "on" : "off"}`, title: on ? "Connected — click to edit" : "Not set up — click to connect", onclick: () => void openConnections() }, on ? "● " : "○ ", label);
  return [
    h("div", { class: "card-head pad" }, h("h1", null, "Inbox"),
      h("div", { class: "row wrap" },
        h("button", { class: "btn", onclick: (e: Event) => void pollNow(e.currentTarget as HTMLButtonElement) }, svg(ICON.sync), "Check now"),
        h("button", { class: "btn ghost", onclick: () => void openConnections() }, "Connect"),
        h("button", { class: "btn ghost", onclick: (e: Event) => void testConnections(e.currentTarget as HTMLButtonElement) }, svg(ICON.check), "Test"),
        st.discord_post ? h("button", { class: "btn ghost", onclick: () => void sharePlan() }, svg(ICON.chat), "Share plan") : null,
        h("button", { class: "btn ghost", onclick: () => openCompose() }, svg(ICON.mail), "New email"))),
    h("div", { class: "chips pad" }, chip(st.email_read, "Email in"), chip(st.email_send, "Email out"), chip(st.discord_read, "Discord in"),
      chip(st.discord_post, "Discord post"), chip(st.canvas_server_token, "Canvas")),
    st.errors && Object.keys(st.errors as object).length ? h("p", { class: "soft-note pad" }, Object.entries(st.errors as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(" · ")) : null,
    h("div", { class: "seg", role: "tablist" }, ([["new", "New"], ["drafts", `Drafts${drafts.filter((d) => d.status === "draft").length ? ` (${drafts.filter((d) => d.status === "draft").length})` : ""}`], ["all", "All"]] as const)
      .map(([k, l]) => h("button", { class: inboxTab === k ? "on" : "", role: "tab", onclick: () => { inboxTab = k; lastView = null; render(); } }, l))),
    inboxTab === "drafts"
      ? (drafts.length ? h("div", { class: "stack" }, drafts.map((d, i) => DraftCard(d, i))) : h("section", { class: "card empty" }, h("p", { class: "muted" }, "No drafts. Ask me: “email my counselor about a 1:1 this week”.")))
      : (items.length ? h("div", { class: "stack" }, items.map((it, i) => InboxCard(it, i))) : h("section", { class: "card empty" }, h("h2", null, "Inbox zero"),
        h("p", { class: "muted" }, "Club Discord messages, counselor emails and screenshots you add show up here."))),
  ];
}

function InboxCard(it: InboxItem, i: number) {
  const icon = it.source === "discord" ? ICON.chat : it.source === "email" ? ICON.mail : ICON.image;
  return h("article", { class: `card inbox-item ${it.source} ${it.status}`, style: `--i:${Math.min(i, 8)}` },
    h("div", { class: "inbox-top" }, h("span", { class: "src" }, svg(icon)), h("b", null, it.from || it.source),
      ...it.tags.map((t) => h("span", { class: "pill warm" }, t)), h("small", { class: "muted" }, it.received_at.replace("T", " ").slice(5, 16))),
    it.subject ? h("h3", null, it.subject) : null,
    h("p", { class: "desc" }, it.text.slice(0, 400)),
    h("div", { class: "row wrap" },
      h("button", { class: "btn sm", onclick: () => { engine.addTasks([newTask(it.subject || it.text.slice(0, 60), it.source === "discord" ? "Club" : "", findDue(it), "inbox")]); engine.setInboxStatus(it.id, "accepted"); toast("Added to your tasks.", "ok"); } }, svg(ICON.plus), "Task"),
      h("button", { class: "btn sm ghost", onclick: () => { const inp = document.getElementById("ask") as HTMLInputElement; inp.value = `I have ${it.subject || "an event"} on `; inp.focus(); engine.setInboxStatus(it.id, "accepted"); } }, "Event"),
      it.source === "email" ? h("button", { class: "btn sm ghost", onclick: () => void replyTo(it) }, svg(ICON.mail), "Reply") : null,
      h("button", { class: "btn sm ghost muted", onclick: () => engine.setInboxStatus(it.id, "dismissed") }, "Dismiss")));
}

function findDue(it: InboxItem): string | null {
  return extractItems(`${it.subject}\n${it.text}`, now())[0]?.due ?? null;
}

async function replyTo(it: InboxItem) {
  const body = (await llm.draftReply(it.from, it.subject, it.text)) || `Hi,\n\nThank you for the message. \n\nBest,\n`;
  engine.addDraft({ to: it.from.match(/<([^>]+)>/)?.[1] ?? it.from, subject: it.subject.startsWith("Re:") ? it.subject : `Re: ${it.subject}`, body, reason: "reply", inbox_id: it.id });
  engine.setInboxStatus(it.id, "accepted");
  inboxTab = "drafts"; lastView = null; render();
}

function DraftCard(d: State["drafts"][number], i: number) {
  const to = h("input", { value: d.to, placeholder: "to@example.com", onchange: (e: Event) => engine.updateDraft(d.id, { to: (e.target as HTMLInputElement).value }) });
  const subj = h("input", { value: d.subject, onchange: (e: Event) => engine.updateDraft(d.id, { subject: (e.target as HTMLInputElement).value }) });
  const body = h("textarea", { rows: "6", onchange: (e: Event) => engine.updateDraft(d.id, { body: (e.target as HTMLTextAreaElement).value }) }, d.body);
  const locked = d.status === "sent";
  if (locked) { to.disabled = subj.disabled = body.disabled = true; }
  return h("article", { class: `card draft ${d.status}`, style: `--i:${Math.min(i, 8)}` },
    h("div", { class: "inbox-top" }, h("span", { class: "src" }, svg(ICON.mail)), h("b", null, d.status === "sent" ? `Sent ${d.sent_at?.replace("T", " ").slice(5) ?? ""}` : d.status === "failed" ? "Couldn't send" : "Draft"),
      h("small", { class: "muted" }, d.reason)),
    d.error ? h("p", { class: "soft-note" }, d.error) : null,
    h("label", null, "To", to), h("label", null, "Subject", subj), h("label", null, "Message", body),
    locked ? null : h("div", { class: "row end" },
      h("button", { class: "btn ghost danger sm", onclick: () => engine.deleteDraft(d.id) }, svg(ICON.trash), "Delete"),
      h("button", { class: "btn primary", onclick: async () => {
        engine.updateDraft(d.id, { to: to.value.trim(), subject: subj.value, body: body.value });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.value.trim())) return toast("Add a valid email address first.", "warn");
        if (!(await confirmSheet("Send this email?", `To ${to.value.trim()}: “${subj.value}”. It goes out from your account right away.`, "Send"))) return;
        try { await engine.sendDraft(d.id); toast(`Sent to ${to.value.trim()} ✉️`, "ok"); } catch (e) { toast(`Not sent: ${(e as Error).message}`, "warn"); }
      } }, svg(ICON.send), "Send")));
}

function openCompose() {
  engine.addDraft({ to: "", subject: "", body: "", reason: "new email" });
  inboxTab = "drafts"; lastView = null; render();
}

async function pollNow(btn?: HTMLButtonElement) {
  btn?.classList.add("spin");
  try {
    const r = await api<{ added: number; error?: string }>("/api/integrations/poll", {});
    await store.pull();
    toast(r.error ? `Checked, with an issue: ${r.error}` : r.added ? `${r.added} new message${r.added > 1 ? "s" : ""}` : "Nothing new.", r.error ? "warn" : "ok");
    void loadIntegrations();
  } catch (e) { toast(`Couldn't check: ${(e as Error).message}`, "warn"); }
  finally { btn?.classList.remove("spin"); }
}

async function testConnections(btn?: HTMLButtonElement) {
  btn?.classList.add("spin");
  try {
    const r = await api<Record<string, { configured: boolean; ok: boolean; detail: string }>>("/api/integrations/test", {});
    const names: Record<string, string> = { email_read: "Email in", email_send: "Email out", discord_read: "Discord in", discord_post: "Discord post" };
    sheet("Connection check", h("div", { class: "stack" },
      ...Object.entries(names).map(([k, label]) => {
        const c = r[k];
        return h("div", { class: `check-row ${!c?.configured ? "off" : c.ok ? "ok" : "bad"}` },
          h("b", null, svg(!c?.configured ? ICON.circle : c.ok ? ICON.check : ICON.x), label), h("p", { class: "muted small" }, c?.detail ?? ""));
      }),
      h("p", { class: "muted small" }, "Nothing was posted or sent. To change settings, open Settings → Connect services.")));
    void loadIntegrations();
  } catch (e) { toast(`Couldn't run the check: ${(e as Error).message}`, "warn"); }
  finally { btn?.classList.remove("spin"); }
}

function planText(): string {
  const s = store.state, today = fmtDate(now());
  const blocks = s.blocks.filter((b) => b.date === today && b.status !== "missed").sort((a, b) => a.start.localeCompare(b.start));
  const lines = blocks.map((b) => `• ${hm12(b.start)} ${b.kind === "bucket" ? (b.bucket === "RESEARCH" ? "Research" : b.bucket) : b.title} (${mins(b)}m)`);
  return `📚 Today's study plan\n${lines.join("\n") || "Nothing planned today 🎉"}`;
}

async function sharePlan() {
  const text = planText();
  if (!(await confirmSheet("Post to Discord?", text, "Post"))) return;
  try { await api("/api/discord/post", { content: text }); toast("Posted to Discord.", "ok"); }
  catch (e) { toast(`Not posted: ${(e as Error).message}`, "warn"); }
}

async function loadIntegrations() {
  try { integrations = await api("/api/integrations"); if (view === "inbox") render(); } catch { integrations = {}; }
}

// ------------------------------------------------------------------ Study Mode (focus)
let focusEl: HTMLElement | null = null;
let focusTick: ReturnType<typeof setInterval> | null = null;
function renderFocus() {
  const t = store.state.timer;
  if (t.state === "idle") { focusEl?.classList.add("out"); const el = focusEl; setTimeout(() => el?.remove(), 300); focusEl = null; if (focusTick) clearInterval(focusTick); focusTick = null; return; }
  const task = t.task_id ? store.state.tasks.find((x) => x.id === t.task_id) : undefined;
  const title = (t.block_id ? store.state.blocks.find((b) => b.id === t.block_id)?.title : undefined)
    ?? (task ? `${task.course ? `${task.course}: ` : ""}${task.title}` : undefined) ?? store.state.buckets.find((b) => b.key === t.bucket)?.name;
  if (!focusEl) {
    const nextInp = h("input", {
      id: "focus-next",
      class: "focus-next",
      placeholder: "Concrete next action (e.g. solve #1–#5, draft intro)…",
      value: t.next_action ?? "",
      onchange: (e: Event) => engine.setTimerNextAction((e.target as HTMLInputElement).value),
    });
    focusEl = h("div", { class: `focus ${COLORS[t.bucket ?? SCHOOL] ?? "teal"}`, role: "dialog", "aria-label": "Study mode" },
      h("div", { class: "focus-inner" },
        h("small", { class: "focus-kicker" }, "Study mode"),
        h("h1", { id: "focus-title" }),
        nextInp,
        h("div", { class: "focus-dial" }, h("div", { class: "focus-ring", id: "focus-ring" }), h("div", { class: "focus-time", id: "focus-time" })),
        h("div", { class: "row center" },
          h("button", { class: "btn glass big", id: "focus-pp", onclick: () => store.state.timer.state === "running" ? engine.timerPause() : engine.timerResume() }),
          h("button", { class: "btn primary big", onclick: openFinish }, svg(ICON.check), "Finish")),
        h("button", { class: "link light", onclick: async () => { if (await confirmSheet("Cancel this session?", "Nothing will be logged.", "Cancel session")) engine.timerCancel(); } }, "Cancel session")));
    document.body.appendChild(focusEl);
  }
  focusEl.className = `focus ${COLORS[t.bucket ?? SCHOOL] ?? "teal"} ${t.state}`;
  focusEl.querySelector("#focus-title")!.textContent = title ?? "Focus";
  const pp = focusEl.querySelector("#focus-pp")!;
  pp.replaceChildren(svg(t.state === "running" ? ICON.pause : ICON.play), t.state === "running" ? "Pause" : "Resume");
  const tick = () => {
    if (!focusEl) return;
    const el = engine.timerElapsed();
    const total = (store.state.timer.planned_min ?? 45) * 60;
    const left = total - el;
    const a = Math.abs(Math.round(left));
    focusEl.querySelector("#focus-time")!.textContent = `${left < 0 ? "+" : ""}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
    const host = focusEl.querySelector("#focus-ring")!;
    const frac = Math.min(1, el / total);
    let fg = host.querySelector(".ring-fg") as SVGCircleElement | null;
    if (!fg) { host.replaceChildren(ring(0, 280, 14, "dial")); fg = host.querySelector(".ring-fg"); }
    const C = Number(fg!.getAttribute("stroke-dasharray"));
    fg!.style.strokeDashoffset = String(C * (1 - frac));
    if (left <= 0 && !focusEl.dataset.chimed) { focusEl.dataset.chimed = "1"; chime(); }
  };
  tick();
  if (!focusTick) focusTick = setInterval(tick, 1000);
}

function chime() {
  try {
    const ctx = new AudioContext();
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.6);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.7);
    });
  } catch { /* no audio */ }
}

function openFinish() {
  let energy: "low" | "med" | "high" = "med";
  let confidence: 1 | 2 | 3 = 2;
  const isTask = !!store.state.timer.task_id;
  const pick = (grp: HTMLElement, btn: HTMLElement) => { for (const b of grp.children) { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); } btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); };
  const eg = h("div", { class: "choice" }, ([["low", ICON.battery, "Drained"], ["med", ICON.smile, "Okay"], ["high", ICON.bolt, "Energized"]] as const).map(([k, e, l]) => {
    const b = h("button", { type: "button", class: k === "med" ? "on" : "", "aria-pressed": String(k === "med"), onclick: () => { energy = k; pick(eg, b); } }, svg(e), l); return b;
  }));
  const cg = h("div", { class: "choice" }, ([[1, "Shaky (review later)"], [2, "Okay"], [3, "Solid"]] as const).map(([v, l]) => {
    const b = h("button", { type: "button", class: v === 2 ? "on" : "", "aria-pressed": String(v === 2), onclick: () => { confidence = v; pick(cg, b); } }, l); return b;
  }));
  const recallInp = h("input", { placeholder: "Quick recall: what did you learn or finish?", autocomplete: "off" });
  const done = (outcome: "done" | "need_more" | "partial", more?: number) => {
    close(); engine.finishSession({ energy, outcome, moreMinutes: more, note: recallInp.value, confidence });
    if (outcome === "done") { confetti(); toast(confidence === 1 && recallInp.value.trim() ? "Logged + scheduled a 20m review in 2 days." : "Logged. Nice work! 🎉", "ok"); } else toast("Logged. The plan adjusted.", "ok");
  };
  const close = sheet("How did it go?", h("div", { class: "stack" },
    h("label", null, "Recall / takeaway (optional)", recallInp),
    h("p", { class: "muted" }, "Confidence on this material?"), cg,
    h("p", { class: "muted" }, "How's your energy?"), eg,
    h("p", { class: "muted" }, isTask ? "Is the assignment finished?" : "How was the session?"),
    h("div", { class: "stack tight" },
      h("button", { class: "btn primary big", onclick: () => done("done") }, svg(ICON.check), isTask ? "Finished it" : "Got through it"),
      isTask ? h("div", { class: "row wrap" }, h("span", { class: "muted" }, "Need more time:"),
        ...[15, 30, 60].map((m) => h("button", { class: "btn sm", onclick: () => done("need_more", m) }, `+${m} min`))) : null,
      h("button", { class: "btn ghost", onclick: () => done("partial") }, "Only got partway"))));
}

// ------------------------------------------------------------------ ask / chat
async function ask(textIn?: string, speak = false): Promise<Reply[]> {
  const input = document.getElementById("ask") as HTMLInputElement;
  const text = (textIn ?? input.value).trim();
  if (!text) return [];
  if (!textIn) input.value = "";
  const dock = document.querySelector(".dock")!;
  dock.classList.add("thinking");
  try {
    const replies = await engine.run(text);
    for (const r of replies) toast(r.text, r.tone ?? "info");
    if (speak) for (const r of replies) await voice.speak(r.text);
    if (replies.some((r) => /^Nice, .* is done/.test(r.text))) confetti();
    return replies;
  } finally { dock.classList.remove("thinking"); }
}

// ------------------------------------------------------------------ voice mode
function openVoice() {
  if (!speechSupported()) { toast("Voice needs Chrome, Edge or Safari's speech recognition. Typing works everywhere.", "warn"); return; }
  let active = true;
  const orb = h("div", { class: "orb" }, h("i"), h("i"), h("i"));
  const said = h("p", { class: "voice-said" }, "Listening…");
  const answer = h("p", { class: "voice-answer" });
  const root = h("div", { class: "voice", role: "dialog", "aria-label": "Voice mode" },
    orb, said, answer,
    h("p", { class: "muted light" }, "Try: “I have robotics until 6 tomorrow”, “what's due this week?”, “start a focus session for AIME”"),
    h("button", { class: "btn glass", onclick: () => stop() }, svg(ICON.x), "Done"));
  document.body.appendChild(root);
  const stop = () => { active = false; voice.abort(); voice.stopSpeaking(); root.classList.add("out"); setTimeout(() => root.remove(), 300); };
  const loop = async () => {
    while (active) {
      orb.className = "orb listening"; said.textContent = "Listening…";
      let text = "";
      try { text = await voice.listen((p) => { said.textContent = p || "Listening…"; }); }
      catch (e) { said.textContent = (e as Error).message; orb.className = "orb"; return; }
      if (!active) return;
      if (!text) { said.textContent = "I didn't hear anything. Tap Done to close, or just talk."; await new Promise((r) => setTimeout(r, 600)); continue; }
      if (/^(stop|bye|goodbye|that's all|thanks|thank you|done)\.?$/i.test(text)) { await voice.speak("Talk soon!"); stop(); return; }
      orb.className = "orb thinking";
      const replies = await engine.run(text);
      for (const r of replies) toast(r.text, r.tone ?? "info");
      answer.textContent = replies.map((r) => r.text).join(" ");
      orb.className = "orb speaking";
      for (const r of replies) { if (!active) return; await voice.speak(r.text); }
    }
  };
  void loop();
}

// ------------------------------------------------------------------ screenshots
function pickImage() { (document.getElementById("file") as HTMLInputElement).click(); }
document.addEventListener("paste", (e) => { const f = fileFromClipboard(e); if (f) { e.preventDefault(); void handleImage(f); } });
document.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); document.body.classList.add("dropping"); } });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop", (e) => {
  document.body.classList.remove("dropping");
  const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); void handleImage(f); }
});

async function handleImage(file: File) {
  const url = URL.createObjectURL(file);
  const bar = h("div", { class: "progress" }, h("i", { style: "--w:5%" }));
  const status = h("p", { class: "muted" }, "Reading the screenshot…");
  const list = h("div", { class: "stack" });
  const body = h("div", { class: "shot" }, h("img", { src: url, alt: "Your screenshot" }), h("div", { class: "stack" }, status, bar, list));
  const close = sheet("From your screenshot", body, { wide: true, onClose: () => URL.revokeObjectURL(url) });
  try {
    const text = await readImage(file, (p, msg) => { (bar.firstElementChild as HTMLElement).style.setProperty("--w", `${Math.round(5 + p * 90)}%`); status.textContent = msg.replace(/^\w/, (c) => c.toUpperCase()); });
    bar.remove();
    let found: Found[] = await llm.extract(text, now());
    if (!found.length) found = extractItems(text, now());
    status.textContent = found.length ? `Found ${found.length} thing${found.length > 1 ? "s" : ""}. Check them, then add.` : "No dates found. You can save the text to your inbox.";
    const rows = found.map((f) => {
      const cb = h("input", { type: "checkbox", checked: true });
      const title = h("input", { value: f.title });
      const due = h("input", { type: "datetime-local", value: f.due ?? "" });
      const kind = h("select", null, h("option", { value: "task" }, "Task"), h("option", { value: "event" }, "Event"));
      kind.value = f.kind;
      list.appendChild(h("div", { class: "found" }, cb, title, due, kind));
      return { f, cb, title, due, kind };
    });
    list.append(h("details", null, h("summary", null, "Text I read"), h("pre", null, text.slice(0, 3000))),
      h("div", { class: "row end" },
        h("button", { class: "btn ghost", onclick: () => { engine.addInbox({ source: "screenshot", from: "Screenshot", subject: found[0]?.title ?? "Screenshot", text: text.slice(0, 3000), tags: [] }); close(); toast("Saved to Inbox.", "ok"); } }, "Save to Inbox"),
        rows.length ? h("button", { class: "btn primary", onclick: () => {
          const tasks: Task[] = [];
          let events = 0;
          for (const r of rows) {
            if (!r.cb.checked || !r.title.value.trim()) continue;
            if (r.kind.value === "event" && r.due.value) {
              const s = r.due.value, e = fmtLocal(new Date(parseLocal(s).getTime() + 90 * 60000));
              store.update((st) => { st.events.push({ id: uid(), title: r.title.value.trim(), kind: "event", start: s, end: e }); });
              events++;
            } else tasks.push(newTask(r.title.value.trim(), r.f.course, r.due.value || null, "screenshot", r.f.minutes));
          }
          if (tasks.length) engine.addTasks(tasks); else engine.replan();
          close(); toast(`Added ${tasks.length} task${tasks.length === 1 ? "" : "s"}${events ? ` and ${events} event${events > 1 ? "s" : ""}` : ""}.`, "ok");
        } }, "Add selected") : null));
  } catch (e) {
    status.textContent = `Couldn't read it: ${(e as Error).message}`;
  }
}

// ------------------------------------------------------------------ smart model + settings
/** Move to the relay's https address, keeping this device signed in (the token rides in the #fragment, never sent to a server). */
function goSecure(): boolean {
  const pub = String(integrations.public_url ?? "");
  if (!pub.startsWith("https://")) return false;
  const t = localStorage.getItem("relay_token");
  location.href = `${pub}/${t ? `#pair=${t}` : ""}`;
  return true;
}

/** Use the relay's model (Settings → Connections) when this browser can't run one. */
async function useRelayAI(): Promise<boolean> {
  const token = localStorage.getItem("relay_token") ?? "";
  if (!(await LLMClient.nativeStatus(token)).ok) return false;
  const ok = await llm.load("native", { token });
  if (ok) { toast(`Smart AI is running through your relay (${llm.status.text}).`, "ok"); void engine.estimateMissing(); }
  return ok;
}

function openModelSheet() {
  const token = localStorage.getItem("relay_token") ?? "";
  let selected = localStorage.getItem("llm_model") || MODELS[0].id;
  const think = h("input", { type: "checkbox", checked: localStorage.getItem("llm_thinking") === "1" });
  const thinkRow = h("label", { class: "toggle" }, think, h("span", null, "Think before answering (more accurate, slower)"));

  const banner = h("div", { class: "ai-banner" });
  const relayMeta = h("span", { class: "muted small" }, "Checking relay AI…");
  const prog = h("div", { class: "progress" }, h("i", { style: `--w:${Math.round(llmStatus.progress * 100)}%` }));
  const txt = h("p", { class: "muted small", role: "status" }, llmStatus.text);
  const startBtn = h("button", { class: "btn primary" }, svg(ICON.spark), "Use selected model");
  const gpuNote = h("div", { class: "gpu-note", hidden: true });

  const cards = new Map<string, HTMLButtonElement>();
  const unloadBtn = h("button", {
    type: "button",
    class: "btn ghost sm",
    onclick: () => { llm.unload(); syncSelection(); render(); toast("Model unloaded from memory.", "ok"); },
  }, "Unload");
  const syncSelection = () => {
    const m = MODELS.find((x) => x.id === selected) ?? MODELS[0];
    thinkRow.hidden = !m.thinks;
    for (const [id, el] of cards) el.classList.toggle("selected", id === selected);
    const isRunningThis = llmStatus.state === "ready" && llmStatus.model === selected;
    startBtn.textContent = isRunningThis ? "Reload / Reconnect" : m.backend === "native" ? "Connect Relay AI" : "Download & start";
    const activeTxt = llmStatus.state === "ready"
      ? `Active: ${llmStatus.provider ?? "AI"} · ${llmStatus.modelLabel ?? llmStatus.model}`
      : llmStatus.state === "loading" ? llmStatus.text
        : "Active: Built-in rules (no LLM loaded)";
    unloadBtn.hidden = llmStatus.state !== "ready";
    banner.replaceChildren(
      h("div", { class: "ai-banner-left" },
        h("span", { class: `sync-dot ${llmStatus.state === "ready" ? "synced" : llmStatus.state === "loading" ? "syncing" : ""}` }),
        h("strong", null, activeTxt)),
      unloadBtn,
    );
  };

  let showAllBrowser = false;
  const closeRef: { fn: () => void } = { fn: () => {} };
  const makeCard = (m: typeof MODELS[number]) => {
    const isActive = llmStatus.state === "ready" && llmStatus.model === m.id;
    const sub = m.backend === "native"
      ? relayMeta
      : h("span", { class: "muted small" }, `${(m.vram / 1000).toFixed(1)} GB VRAM${m.note ? ` · ${m.note}` : ""}`);
    const btn = h("button", {
      type: "button",
      class: `model-card ${m.backend === "native" ? "hero" : ""} ${m.id === selected ? "selected" : ""} ${isActive ? "active" : ""}`,
      onclick: () => { selected = m.id; syncSelection(); },
    },
      h("div", { class: "row", style: "justify-content:space-between;align-items:center;width:100%;gap:8px" },
        h("strong", null, m.label),
        isActive ? h("span", { class: "pill warm" }, "Running") : h("span", { class: "pill" }, m.backend === "native" ? "0 MB" : m.size)),
      sub);
    cards.set(m.id, btn);
    return btn;
  };
  const extraGroups = (["Small & fast", "Bigger & smarter"] as const).map((g) => h("div", { class: "model-group", hidden: true },
    h("div", { class: "model-group-title" }, g),
    h("div", { class: "model-grid" }, MODELS.filter((m) => m.group === g).map(makeCard))));
  const extraCount = MODELS.filter((m) => m.group === "Small & fast" || m.group === "Bigger & smarter").length;
  const moreBtn = h("button", {
    type: "button",
    class: "btn ghost sm",
    style: "justify-self:start",
    onclick: () => {
      showAllBrowser = !showAllBrowser;
      for (const el of extraGroups) el.hidden = !showAllBrowser;
      moreBtn.textContent = showAllBrowser ? "Hide extra browser models" : `Show ${extraCount} more browser models…`;
    },
  }, `Show ${extraCount} more browser models…`);

  const listWrap = h("div", { class: "model-groups" },
    h("div", { class: "model-group" },
      h("div", { class: "model-group-title" }, "Relay AI (instant · zero lag)"),
      h("div", { class: "model-grid" }, MODELS.filter((m) => m.group === "Through your relay").map(makeCard))),
    h("div", { class: "model-group" },
      h("div", { class: "model-group-title" }, "In-Browser WebGPU"),
      h("div", { class: "model-grid" }, MODELS.filter((m) => m.group === "Recommended").map(makeCard))),
    moreBtn,
    ...extraGroups,
  );

  void LLMClient.nativeStatus(token).then((st) => {
    if (!st.ok) {
      relayMeta.textContent = st.error
        ? `Not ready: ${st.error}`
        : "Not connected — click Configure below for OpenRouter / OpenAI / Ollama";
      return;
    }
    const prov = st.url?.includes("openrouter.ai") ? "OpenRouter"
      : st.url?.includes("openai.com") ? "OpenAI"
        : st.url?.includes("azure.com") ? "Azure" : "Ollama";
    const ctxK = Math.round((st.context_window ?? 32768) / 1024);
    relayMeta.textContent = `${prov}: ${st.model ?? "lfm2.5"} · ${ctxK}K ctx`;
    if (llmStatus.state === "ready" && llmStatus.model === "native") syncSelection();
  });

  if (llmStatus.state !== "ready" && llmStatus.state !== "loading") {
    void checkWebGPU().then(async (g) => {
      if (g.ok) return;
      const pub = String(integrations.public_url ?? "");
      const relayOk = (await LLMClient.nativeStatus(token)).ok;
      gpuNote.hidden = false;
      gpuNote.replaceChildren(h("p", null, g.text, relayOk ? " Your relay has a model, so Smart AI can run through it instead." : ""), h("div", { class: "row" },
        g.reason === "insecure" && pub.startsWith("https://") ? h("button", { class: "btn primary sm", onclick: () => goSecure() }, "Open the secure link") : null,
        g.reason === "no-adapter" ? h("button", { class: "btn sm", onclick: () => location.reload() }, "Reload page") : null,
        relayOk ? h("button", { class: "btn ghost sm", onclick: async () => { if (await useRelayAI()) { syncSelection(); render(); } } }, "Use Relay AI instead") : null));
    });
  }

  startBtn.onclick = async () => {
    startBtn.disabled = think.disabled = true;
    localStorage.setItem("llm_model", selected);
    localStorage.setItem("llm_thinking", think.checked ? "1" : "0");
    const m = MODELS.find((x) => x.id === selected)!;
    if (await llm.load(selected, { thinking: !!m.thinks && think.checked, token })) {
      toast(`Smart AI ready: ${llm.status.modelLabel ?? m.label}`, "ok");
      syncSelection();
      render();
      void engine.estimateMissing();
    } else if (llm.status.state === "unsupported") {
      if (llm.status.reason === "insecure" && goSecure()) return;
      if (!(await useRelayAI())) toast(llm.status.text, "warn");
    } else {
      const errText = llm.status.text;
      if (m.backend !== "native" && (await useRelayAI())) {
        syncSelection();
        render();
      } else {
        toast(errText, "warn");
      }
    }
    startBtn.disabled = think.disabled = false;
  };

  syncSelection();
  const unsub = setInterval(() => {
    (prog.firstElementChild as HTMLElement).style.setProperty("--w", `${Math.round(llmStatus.progress * 100)}%`);
    txt.textContent = llmStatus.text;
  }, 300);

  closeRef.fn = sheet("AI & Model Selection", h("div", { class: "stack" },
    banner,
    gpuNote,
    listWrap,
    thinkRow,
    txt,
    llmStatus.state === "loading" ? prog : null,
    h("div", { class: "row end" },
      h("button", { type: "button", class: "btn ghost", onclick: () => { closeRef.fn(); void openConnections(); } }, "Configure Relay AI…"),
      startBtn),
  ), { onClose: () => clearInterval(unsub) });
}

function openLoginSheet() {
  const userInp = h("input", { type: "text", placeholder: "Username", autocomplete: "username" });
  const passInp = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const errLine = h("p", { class: "muted small", style: "color:var(--danger)", hidden: true });
  const submitBtn = h("button", { type: "submit", class: "btn primary" }, "Sign in");
  const close = sheet("Sign in to Study Flow", h("form", { class: "stack", onsubmit: async (e: Event) => {
    e.preventDefault();
    errLine.hidden = true;
    const u = userInp.value.trim();
    const p = passInp.value;
    if (!u || !p) {
      errLine.textContent = "Enter your username and password.";
      errLine.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      const j = await r.json().catch(() => ({})) as { ok?: boolean; token?: string; error?: string };
      if (!r.ok || !j.token) {
        errLine.textContent = j.error || "Invalid username or password";
        errLine.hidden = false;
        passInp.value = "";
        passInp.focus();
        return;
      }
      localStorage.setItem("relay_token", j.token);
      store.lastError = "";
      tokenHintShown = false;
      close();
      await store.pull();
      if (/\b401\b|bad relay token/.test(store.lastError)) {
        localStorage.removeItem("relay_token");
        openLoginSheet();
        return;
      }
      void loadIntegrations();
      render();
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  } },
    h("label", null, "Username", userInp),
    h("label", null, "Password", passInp),
    errLine,
    h("div", { class: "row end" }, submitBtn)), { locked: true });
  userInp.focus();
}

function openSettings() {
  const s = store.state;
  const ics = h("input", { value: localStorage.getItem("ics_url") ?? "", placeholder: "https://esuhsd.instructure.com/feeds/calendars/user_….ics" });
  const motion = h("input", { type: "checkbox", checked: localStorage.getItem("motion") !== "off" });
  const targets = s.buckets.filter((b) => b.key !== SCHOOL).map((b) => {
    const inp = h("input", { type: "range", min: "0", max: "15", step: "0.5", value: b.target_hours });
    const out = h("output", null, `${b.target_hours} h`);
    inp.addEventListener("input", () => { out.textContent = `${inp.value} h`; });
    return { b, inp, row: h("label", { class: `slider ${COLORS[b.key]}` }, h("span", null, b.name), inp, out) };
  });
  const r = s.rules;
  const commute = h("input", { type: "number", min: "0", max: "120", step: "5", value: String(r.commute_min ?? 0) });
  const restDays = new Set<number>(r.rest_days ?? []);
  const restRow = h("div", { class: "chips" }, ([1, 2, 3, 4, 5, 6, 7] as const).map((d, idx) => {
    const lbl = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][idx];
    const b = h("button", {
      type: "button",
      class: `chip ${restDays.has(d) ? "on" : "off"}`,
      onclick: () => { if (restDays.has(d)) restDays.delete(d); else restDays.add(d); b.className = `chip ${restDays.has(d) ? "on" : "off"}`; },
    }, lbl);
    return b;
  }));
  const quietWd = h("input", { value: r.quiet_weekday.join(", "), placeholder: "16:15-18:30" });
  const quietWe = h("input", { value: r.quiet_weekend.join(", "), placeholder: "09:00-12:00, 14:00-17:00" });
  const unavailTitle = h("input", { placeholder: "e.g. Swim practice, Tutoring" });
  const unavailDate = h("input", { type: "date", value: fmtDate(now()) });
  const unavailStart = h("input", { type: "time", value: "17:00" });
  const unavailEnd = h("input", { type: "time", value: "18:30" });
  const close = sheet("Settings", h("div", { class: "stack" },
    h("h3", null, "Weekly goals"), ...targets.map((t) => t.row),
    h("h3", null, "Your day & preferences"),
    h("p", { class: "muted small" }, `School ${hm12(r.school_start)}–${hm12(r.school_end)} on weekdays · ${r.after_school_min}-min break after school · dinner ${hm12(r.dinner_start)} (${r.dinner_min} min) · lights out ${hm12(r.sleep_cutoff)} (never moved)`),
    h("label", null, "Commute after school (minutes)", commute),
    h("div", null, h("span", { class: "small muted" }, "Days kept completely free of study"), restRow),
    h("div", { class: "row" },
      h("label", { style: "flex:1" }, "Preferred weekday windows", quietWd),
      h("label", { style: "flex:1" }, "Preferred weekend windows", quietWe)),
    h("h3", null, "Add unavailable time"),
    h("div", { class: "row wrap" }, unavailTitle, unavailDate, unavailStart, unavailEnd,
      h("button", { type: "button", class: "btn ghost sm", onclick: () => {
        if (!unavailDate.value || !unavailStart.value || !unavailEnd.value) return;
        store.update((st) => {
          st.events.push({ id: uid(), title: unavailTitle.value.trim() || "Unavailable", kind: "blackout", start: `${unavailDate.value}T${unavailStart.value}`, end: `${unavailDate.value}T${unavailEnd.value}` });
          engine.replanInto(st);
        });
        unavailTitle.value = "";
        toast("Unavailable time blocked and preserved on replans.", "ok");
      } }, "Block time")),
    h("h3", null, "Connections"),
    h("button", { type: "button", class: "btn", onclick: () => { close(); void openConnections(); } }, "Connect Discord, Gmail, Canvas & AI…"),
    h("label", null, "Canvas calendar feed (fallback)", ics),
    h("label", { class: "toggle" }, motion, h("span", null, "Animations")),
    h("div", { class: "row wrap", style: "justify-content:space-between" },
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn ghost sm", onclick: () => { const n = engine.clearSampleData(); toast(n ? `Cleared ${n} sample task(s).` : "No sample data found.", "ok"); } }, "Clear sample data"),
        h("button", { type: "button", class: "btn ghost sm", onclick: () => { localStorage.removeItem("relay_token"); close(); openLoginSheet(); } }, "Sign out"),
        h("button", { type: "button", class: "btn ghost sm danger", onclick: async () => {
          if (!(await confirmSheet("Reset all data?", "Clears all tasks, blocks, and sessions to start fresh.", "Reset everything"))) return;
          await api("/api/account/reset", { method: "POST" });
          location.reload();
        } }, "Reset all")),
      h("button", { class: "btn primary", onclick: () => {
      localStorage.setItem("ics_url", ics.value.trim());
      localStorage.setItem("motion", motion.checked ? "on" : "off");
      document.documentElement.dataset.motion = motion.checked ? "on" : "off";
      const parseWins = (v: string, fb: string[]) => {
        const list = v.split(",").map((x) => x.trim()).filter((x) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(x));
        return list.length ? list : fb;
      };
      store.update((st) => {
        st.rules.commute_min = Math.max(0, Math.min(120, Number(commute.value) || 0));
        st.rules.rest_days = [...restDays].sort();
        st.rules.quiet_weekday = parseWins(quietWd.value, st.rules.quiet_weekday);
        st.rules.quiet_weekend = parseWins(quietWe.value, st.rules.quiet_weekend);
        for (const t of targets) { const b = st.buckets.find((x) => x.key === t.b.key); if (b) b.target_hours = Number(t.inp.value); }
        engine.replanInto(st);
      });
      close(); toast("Saved.", "ok"); void store.pull();
    } }, "Save"))));
}

async function openConnections() {
  let cfg: Record<string, unknown> = {};
  try { cfg = await api<Record<string, unknown>>("/api/integrations/config"); }
  catch (err) {
    toast(`Could not load saved connection settings: ${(err as Error).message}`, "warn");
    return;
  }
  const savedHint = (ok: unknown, fallback: string) => ok ? "Saved (leave blank to keep)" : fallback;

  const prov = h("select", null,
    h("option", { value: "gmail" }, "Gmail (imap.gmail.com / smtp.gmail.com)"),
    h("option", { value: "icloud" }, "iCloud Mail"),
    h("option", { value: "yahoo" }, "Yahoo Mail"),
    h("option", { value: "custom" }, "Custom IMAP/SMTP"));
  const emailUser = h("input", { type: "email", value: String(cfg.imap_user ?? ""), placeholder: "you@gmail.com" });
  const emailPass = h("input", { type: "password", placeholder: savedHint(cfg.imap_configured, "16-char Google App Password"), autocomplete: "off" });
  const emailFilters = h("input", { value: String(cfg.imap_filters ?? ""), placeholder: "esuhsd.org,counselor,robotics" });

  const botToken = h("input", { type: "password", placeholder: savedHint(cfg.discord_bot_configured, "Discord Bot Token"), autocomplete: "off" });
  const channels = h("input", { value: String(cfg.discord_channel_ids ?? ""), placeholder: "123456789012345678, ..." });
  const webhook = h("input", { type: "password", placeholder: savedHint(cfg.discord_webhook_configured, "Optional webhook URL to post plans"), autocomplete: "off" });

  const canvasUrl = h("input", { value: String(cfg.canvas_base_url ?? "https://esuhsd.instructure.com"), placeholder: "https://esuhsd.instructure.com" });
  const canvasTok = h("input", { type: "password", placeholder: savedHint(cfg.canvas_configured, "Canvas API Access Token"), autocomplete: "off" });

  const savedLLMUrl = String(cfg.local_llm_url ?? "http://127.0.0.1:11434/v1");
  const initialProvider = savedLLMUrl.includes("openrouter.ai") ? "openrouter"
    : savedLLMUrl.includes("azure.com") ? "azure"
      : savedLLMUrl.includes("api.openai.com") ? "openai" : "local";
  let currentProvider = initialProvider;
  const llmUrl = h("input", { value: savedLLMUrl });
  const llmModel = h("input", { value: String(cfg.local_llm_model ?? "lfm2.5") });
  const llmKey = h("input", { type: "password", placeholder: "", autocomplete: "new-password" });
  const llmCtx = h("input", { type: "number", min: "2048", max: "131072", step: "1024", value: String(cfg.local_llm_ctx ?? 32768) });
  const providerKeys: Record<string, { configured: boolean; placeholder: string; url: string; model: string }> = {
    openrouter: { configured: Boolean(cfg.openrouter_key_configured),
      placeholder: "OpenRouter API key (sk-or-…)", url: "https://openrouter.ai/api/v1", model: "google/gemma-4-31b-it:free" },
    openai: { configured: Boolean(cfg.openai_key_configured),
      placeholder: "OpenAI API key", url: "https://api.openai.com/v1", model: "gpt-6-luna" },
    azure: { configured: Boolean(cfg.azure_key_configured),
      placeholder: "Azure OpenAI API key", url: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", model: "gpt-6-luna" },
    local: { configured: Boolean(cfg.local_key_configured)
      || (initialProvider === "local" && Boolean(cfg.local_llm_key_configured)),
      placeholder: "Optional API key for your local/custom endpoint", url: "http://127.0.0.1:11434/v1", model: "lfm2.5" },
  };
  const keyDrafts: Record<string, string> = {};
  const modelDrafts: Record<string, { url: string; model: string; context: string }> = {
    [initialProvider]: { url: llmUrl.value, model: llmModel.value, context: llmCtx.value },
  };
  const providerIds = ["openrouter", "openai", "azure", "local"] as const;
  const providerLabels: Record<(typeof providerIds)[number], string> = {
    openrouter: "OpenRouter", openai: "OpenAI", azure: "Azure", local: "Local / custom",
  };
  const providerButtons: HTMLButtonElement[] = [];
  const keyStatus = h("p", { class: "provider-key-status", "aria-live": "polite" }, "");
  const isProviderKeySaved = (provider: string) => providerKeys[provider].configured
    || (provider === initialProvider && Boolean(cfg.local_llm_key_configured));
  const updateProviderKeyHint = () => {
    const p = providerKeys[currentProvider];
    llmKey.placeholder = p.placeholder;
    const configured = isProviderKeySaved(currentProvider);
    keyStatus.className = `provider-key-status ${configured ? "saved" : "empty"}`;
    keyStatus.replaceChildren(
      h("span", { class: "provider-key-dot", "aria-hidden": "true" }),
      configured
        ? "API key saved on your relay. Leave blank to keep it, or enter a new one to replace it."
        : "No key saved for this provider yet. Enter it once and it will be saved on your relay.",
    );
    providerButtons.forEach((button) => {
      const provider = button.dataset.provider!;
      const active = provider === currentProvider;
      button.classList.toggle("on", active);
      button.setAttribute("aria-pressed", String(active));
      button.querySelector("small")!.textContent = isProviderKeySaved(provider) ? "Key saved"
        : provider === "local" ? "Key optional" : "Add API key";
    });
  };
  const changeLLMProvider = (provider: string) => {
    keyDrafts[currentProvider] = llmKey.value;
    modelDrafts[currentProvider] = { url: llmUrl.value, model: llmModel.value, context: llmCtx.value };
    currentProvider = provider;
    const p = providerKeys[currentProvider];
    const draft = modelDrafts[currentProvider] ?? { url: p.url, model: p.model, context: "32768" };
    llmUrl.value = draft.url;
    llmModel.value = draft.model;
    llmCtx.value = draft.context;
    llmKey.value = keyDrafts[currentProvider] ?? "";
    updateProviderKeyHint();
  };
  const providerNav = h("div", { class: "provider-nav", role: "group", "aria-label": "AI model provider" },
    ...providerIds.map((id) => {
      const button = h("button", { class: `provider-choice ${id === initialProvider ? "on" : ""}`, type: "button",
        "aria-pressed": String(id === initialProvider), "data-provider": id,
        onclick: () => changeLLMProvider(id) },
        h("span", null, providerLabels[id]),
        h("small", null, isProviderKeySaved(id) ? "Key saved" : id === "local" ? "Key optional" : "Add API key"));
      providerButtons.push(button);
      return button;
    }));
  updateProviderKeyHint();

  const serviceIds = ["email", "discord", "canvas", "ai"] as const;
  const serviceLabels: Record<(typeof serviceIds)[number], string> = {
    email: "Email", discord: "Discord", canvas: "Canvas", ai: "AI model",
  };
  const serviceTabs: HTMLButtonElement[] = [];
  const servicePanels: HTMLElement[] = [];
  const activateService = (selected: string) => {
    serviceTabs.forEach((tab) => {
      const active = tab.dataset.service === selected;
      tab.classList.toggle("on", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    servicePanels.forEach((panel) => { panel.hidden = panel.dataset.service !== selected; });
  };
  const serviceNav = h("div", { class: "connection-nav", role: "tablist", "aria-label": "Connection type" },
    ...serviceIds.map((id, index) => {
      const tab = h("button", { class: `connection-tab ${id === "ai" ? "on" : ""}`, id: `connection-tab-${id}`,
        type: "button", role: "tab", "aria-controls": `connection-panel-${id}`, "aria-selected": String(id === "ai"),
        tabindex: id === "ai" ? "0" : "-1", "data-service": id,
        onclick: () => activateService(id),
        onkeydown: (e: KeyboardEvent) => {
          let next = index;
          if (e.key === "ArrowRight") next = (index + 1) % serviceIds.length;
          else if (e.key === "ArrowLeft") next = (index + serviceIds.length - 1) % serviceIds.length;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = serviceIds.length - 1;
          else return;
          e.preventDefault();
          activateService(serviceIds[next]);
          serviceTabs[next].focus();
        } },
        h("span", { class: "connection-tab-name" }, serviceLabels[id]),
        h("small", null, id === "ai" ? "OpenRouter, OpenAI, local" : id === "email" ? "Gmail or other mail" : id === "discord" ? "Channels & webhooks" : "Classes & assignments"));
      serviceTabs.push(tab);
      return tab;
    }));
  const servicePanel = (id: (typeof serviceIds)[number], child: Node) => {
    const panel = h("section", { class: "connection-panel", id: `connection-panel-${id}`, role: "tabpanel",
      "aria-labelledby": `connection-tab-${id}`, "data-service": id, hidden: id !== "ai" }, child);
    servicePanels.push(panel);
    return panel;
  };

  const close = sheet("Connect services", h("form", { class: "connections-form", onsubmit: async (e: Event) => {
    e.preventDefault();
    const btn = (e.currentTarget as HTMLFormElement).querySelector("button[type=submit]") as HTMLButtonElement;
    btn.disabled = true; btn.textContent = "Saving & testing…";
    try {
      const res = await api<{ status: Record<string, unknown> }>("/api/integrations/config", {
        method: "POST",
        body: JSON.stringify({
          email_provider: prov.value,
          email_user: emailUser.value.trim(),
          email_password: emailPass.value.trim(),
          imap_filters: emailFilters.value.trim(),
          discord_bot_token: botToken.value.trim(),
          discord_channel_ids: channels.value.trim(),
          discord_webhook_url: webhook.value.trim(),
          canvas_base_url: canvasUrl.value.trim(),
          canvas_api_token: canvasTok.value.trim(),
          local_llm_url: llmUrl.value.trim(),
          local_llm_model: llmModel.value.trim(),
          local_llm_api_key: llmKey.value.trim(),
          llm_provider: currentProvider,
          local_llm_ctx: Number(llmCtx.value) || 32768,
        }),
      });
      integrations = res.status;
      render();
      close();
      await testConnections();
    } catch (err) {
      toast(`Could not save: ${(err as Error).message}`, "warn");
      btn.disabled = false; btn.textContent = "Save & Test";
    }
  } },
    h("p", { class: "connections-intro" }, "Bring your classes, messages, and study tools into one plan. Leave a secret blank to keep the value already saved."),
    serviceNav,
    h("div", { class: "connection-panels" },
      servicePanel("email", h("section", { class: "connection-card email" },
        h("div", { class: "connection-card-head" }, h("span", { class: "connection-icon" }, svg(ICON.mail)),
          h("div", null, h("h3", null, "Email"), h("p", null, "Read school updates and send messages."))),
        h("label", null, "Provider", prov),
        h("label", null, "Email address", emailUser),
        h("label", null, "App password", emailPass),
        h("label", null, "Only match these senders or subjects", emailFilters))),
      servicePanel("discord", h("section", { class: "connection-card discord" },
        h("div", { class: "connection-card-head" }, h("span", { class: "connection-icon" }, svg(ICON.chat)),
          h("div", null, h("h3", null, "Discord"), h("p", null, "Capture messages from selected channels."))),
        h("label", null, "Bot token", botToken),
        h("label", null, "Channel IDs", channels),
        h("label", null, "Webhook URL (optional)", webhook))),
      servicePanel("canvas", h("section", { class: "connection-card canvas" },
        h("div", { class: "connection-card-head" }, h("span", { class: "connection-icon" }, svg(ICON.school)),
          h("div", null, h("h3", null, "Canvas"), h("p", null, "Sync classes, assignments, and due dates."))),
        h("label", null, "Canvas URL", canvasUrl),
        h("label", null, "API token", canvasTok))),
      servicePanel("ai", h("section", { class: "connection-card relay" },
        h("div", { class: "connection-card-head" }, h("span", { class: "connection-icon" }, svg(ICON.spark)),
          h("div", null, h("h3", null, "AI model provider"), h("p", null, "Choose where Study Relay sends AI requests. Each provider keeps its own saved key."))),
        providerNav,
        h("div", { class: "connection-fields" },
          h("label", { class: "connection-full" }, "OpenAI-compatible URL", llmUrl),
          h("label", null, "Model", llmModel),
          h("label", { class: "connection-context" }, "Context length", llmCtx),
          h("label", { class: "connection-full" }, "API key", llmKey)),
        keyStatus,
        h("div", { class: "provider-note" }, "OpenRouter: use your OpenRouter key and an exact model ID from your OpenRouter account. Local Ollama does not need a key.")))),
    h("div", { class: "connections-actions" },
      h("p", { class: "connections-security-note" }, svg(ICON.check), " Secrets are saved only on your relay server and never sent back to this browser."),
      h("div", { class: "row end" },
        h("button", { type: "button", class: "btn ghost", onclick: () => close() }, "Cancel"),
        h("button", { type: "submit", class: "btn primary" }, "Save & Test"))),
  ), { wide: true, className: "connections-sheet", focusSelector: "#connection-tab-ai" });
}

// ------------------------------------------------------------------ boot
document.documentElement.dataset.motion = localStorage.getItem("motion") === "off" ? "off" : "on";
let tokenHintShown = false;
{
  const m = location.hash.match(/^#pair=([A-Za-z0-9_-]{16,128})$/);
  if (m) {
    localStorage.setItem("relay_token", m[1]);
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(() => toast("Signed in.", "ok"), 600);
  }
}
store.subscribe(() => render());
engine.onTimer = () => render();
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/INPUT|TEXTAREA/.test((document.activeElement as HTMLElement)?.tagName)) { e.preventDefault(); (document.getElementById("ask") as HTMLInputElement).focus(); }
});

(async () => {
  await store.load();
  engine.cfc = CfCScheduler.fromJSON(store.state.cfc);
  engine.afterSync(true); // fresh plan on every open (time has moved on)
  await loadIntegrations();
  if (!store.state.tasks.length && integrations.canvas_server_token) void doCanvasSync();
  else void engine.estimateMissing();
  void refreshGrades();
  setInterval(async () => { if (await store.pull()) engine.afterSync(); }, 20000);
  setInterval(() => { engine.afterSync(); render(); }, 60000); // close out passed blocks, refresh countdowns
  document.addEventListener("visibilitychange", async () => { if (!document.hidden && (await store.pull())) engine.afterSync(); });
})();
render();
