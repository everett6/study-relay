// Local wall-clock helpers. All stored times are "YYYY-MM-DDTHH:MM" in the user's timezone.

export const pad = (n: number): string => String(n).padStart(2, "0");

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtLocal(d: Date): string {
  return `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseLocal(s: string): Date {
  const [date, time = "00:00"] = s.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.slice(0, 5).split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

export function hm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function atMin(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

export const minutesBetween = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / 60000);

/** ISO-8601 week id, e.g. 2026-W47 (matches Go's time.ISOWeek). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(w)}`;
}

export function mondayOf(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

export const isoDow = (d: Date): number => d.getDay() || 7; // 1=Mon .. 7=Sun

export function hm12(s: string | Date): string {
  const d = typeof s === "string" ? parseLocal(s) : s;
  const h = d.getHours();
  return `${((h + 11) % 12) + 1}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
