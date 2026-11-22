// Tiny DOM helpers (no framework): h() builds elements, plus toasts, sheets and confetti.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

let openSheetCount = 0;
let previousDocumentOverflow = "";

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else if (k === "checked") (el as HTMLInputElement).checked = !!v;
    else if (k === "html") el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

function append(el: Node, kids: Child[]) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
  }
}

export function svg(markup: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = markup;
  return s;
}

const P = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  week: P('<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
  tasks: P('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>'),
  inbox: P('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>'),
  mic: P('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>'),
  camera: P('<path d="M3 8a2 2 0 0 1 2-2h2l2-3h6l2 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/>'),
  send: P('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>'),
  gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  play: P('<path d="m6 4 14 8-14 8z" fill="currentColor"/>'),
  pause: P('<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>'),
  check: P('<path d="m4 12 5 5L20 6"/>'),
  x: P('<path d="M18 6 6 18M6 6l12 12"/>'),
  sync: P('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>'),
  spark: P('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  mail: P('<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m22 7-10 6L2 7"/>'),
  chat: P('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>'),
  image: P('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'),
  trash: P('<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  school: P('<path d="m3 10 9-6 9 6"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>'),
  cup: P('<path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 2v3M12 2v3"/>'),
  utensils: P('<path d="M6 2v8a2 2 0 0 0 4 0V2M8 10v12"/><path d="M18 22V2c-2.2 1.3-3 4-3 7v4h3"/>'),
  moon: P('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>'),
  ticket: P('<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M13 6v2M13 11v2M13 16v2"/>'),
  shirt: P('<path d="m8 3-5 3 2 5 3-1v11h8V10l3 1 2-5-5-3a4 4 0 0 1-8 0z"/>'),
  battery: P('<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M6 11v2"/>'),
  smile: P('<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>'),
  bolt: P('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  rocket: P('<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2-.1-2.8a2 2 0 0 0-2.9-.2z"/><path d="M12 15 9 12a15 15 0 0 1 11-9 15 15 0 0 1-9 11z"/><path d="M9 12H5l2-4h5M12 15v4l4-2v-5"/>'),
  waves: P('<path d="M2 7c2 0 2-2 5-2s3 2 5 2 2-2 5-2 3 2 5 2M2 13c2 0 2-2 5-2s3 2 5 2 2-2 5-2 3 2 5 2M2 19c2 0 2-2 5-2s3 2 5 2 2-2 5-2 3 2 5 2"/>'),
  cloudSun: P('<path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M17.7 6.3l1.4-1.4"/><path d="M15.9 11A4 4 0 0 0 8 10.5"/><path d="M17 21H8a4 4 0 1 1 1.2-7.8A5 5 0 0 1 18.5 15 3 3 0 0 1 17 21z"/>'),
  heart: P('<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z"/>'),
  circle: P('<circle cx="12" cy="12" r="8"/>'),
};

// ------------------------------------------------------------------ toasts
export function toast(text: string, tone: "ok" | "warn" | "info" = "info", ms = 5200): void {
  const host = document.getElementById("toasts")!;
  const el = h("div", { class: `toast ${tone}`, role: "status" }, text);
  host.appendChild(el);
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 320); };
  el.addEventListener("click", close);
  setTimeout(close, ms + Math.min(6000, text.length * 40));
}

// ------------------------------------------------------------------ sheets (bottom modal)
export function sheet(title: string, body: Node, opts: { wide?: boolean; className?: string; focusSelector?: string; locked?: boolean; onClose?: () => void } = {}): () => void {
  const root = document.getElementById("overlay")!;
  if (openSheetCount === 0) {
    previousDocumentOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }
  openSheetCount++;
  const card = h("div", { class: `sheet ${opts.wide ? "wide" : ""} ${opts.className ?? ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheet-head" }, h("h2", null, title), opts.locked ? null : h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => close() }, svg(ICON.x))),
    body);
  const scrim = h("div", { class: "scrim", onclick: (e: Event) => { if (!opts.locked && e.target === scrim) close(); } }, card);
  root.appendChild(scrim);
  const onKey = (e: KeyboardEvent) => { if (!opts.locked && e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    scrim.classList.add("out");
    setTimeout(() => {
      scrim.remove();
      openSheetCount--;
      if (openSheetCount === 0) document.documentElement.style.overflow = previousDocumentOverflow;
    }, 260);
    opts.onClose?.();
  }
  requestAnimationFrame(() => (card.querySelector(opts.focusSelector ?? "input,textarea,button.primary") as HTMLElement | null)?.focus());
  return close;
}

export function confirmSheet(title: string, message: string, yes: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const close = sheet(title, h("div", { class: "stack" },
      h("p", { class: "muted" }, message),
      h("div", { class: "row end" },
        h("button", { class: "btn ghost", onclick: () => { answered = true; resolve(false); close(); } }, "Cancel"),
        h("button", { class: "btn primary", onclick: () => { answered = true; resolve(true); close(); } }, yes))),
    { onClose: () => { if (!answered) resolve(false); } });
  });
}

// ------------------------------------------------------------------ confetti
export function confetti(): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "off") return;
  const c = h("canvas", { class: "confetti" });
  document.body.appendChild(c);
  const ctx = c.getContext("2d")!;
  const W = (c.width = innerWidth * devicePixelRatio), H = (c.height = innerHeight * devicePixelRatio);
  const colors = ["#8b5cf6", "#06b6d4", "#f59e0b", "#ec4899", "#22c55e", "#3b82f6"];
  const parts = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.2, y: H * 0.65, vx: (Math.random() - 0.5) * 22 * devicePixelRatio,
    vy: -(Math.random() * 22 + 12) * devicePixelRatio, r: (Math.random() * 6 + 4) * devicePixelRatio, a: Math.random() * 6,
    va: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const frame = (t: number) => {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.6 * devicePixelRatio; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - (t - t0) / 2600);
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (t - t0 < 2600) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

/** SVG progress ring. */
export function ring(frac: number, size = 120, stroke = 12, cls = ""): SVGSVGElement {
  const r = (size - stroke) / 2, C = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg class="ring ${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" fill="none"/>
    <circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" fill="none"
      stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - f)}" transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"/></svg>`;
  const el = wrap.firstElementChild as SVGSVGElement;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fg = el.querySelector(".ring-fg") as SVGCircleElement;
    fg.style.strokeDashoffset = fg.dataset.target!;
  }));
  return el;
}
