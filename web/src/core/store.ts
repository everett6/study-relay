// Local-first store: the state document lives in IndexedDB and syncs with the relay's
// /api/sync using optimistic versions. Local edits are mutation functions, so on a 409
// the client re-applies its pending edits on top of the server's document and retries.

import { defaultState, type State } from "./types";

const DB = "study-relay", STORE = "kv";

function idb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((res) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => res(null);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((res) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result as T);
    r.onerror = () => res(undefined);
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  if (!db) return;
  await new Promise<void>((res) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

export type Mutation = (s: State) => void;
export type SyncStatus = "offline" | "syncing" | "synced" | "error";

export interface Transport {
  get(): Promise<{ version: number; state: State; server_time?: string }>;
  put(base: number, state: State): Promise<{ ok: true; version: number } | { ok: false; version: number; state: State }>;
}

export function httpTransport(base = ""): Transport {
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const t = typeof localStorage !== "undefined" ? localStorage.getItem("relay_token") : null;
    if (t) h["X-Relay-Token"] = t;
    return h;
  };
  return {
    async get() {
      const r = await fetch(`${base}/api/sync`, { headers: headers() });
      if (!r.ok) throw new Error(`sync ${r.status}`);
      return r.json();
    },
    async put(baseVersion, state) {
      const r = await fetch(`${base}/api/sync`, { method: "POST", headers: headers(), body: JSON.stringify({ base_version: baseVersion, state }) });
      const j = await r.json();
      if (r.status === 409) return { ok: false, version: j.version, state: j.state };
      if (!r.ok) throw new Error(j.error ?? `sync ${r.status}`);
      return { ok: true, version: j.version };
    },
  };
}

/** Fill fields an older document may lack. */
export function normalize(s: Partial<State> | null | undefined): State {
  const d = defaultState();
  const st = { ...d, ...(s ?? {}) } as State;
  st.rules = { ...d.rules, ...(s?.rules ?? {}) };
  for (const k of ["buckets", "tasks", "events", "blocks", "sessions", "feedback", "inbox", "drafts"] as const)
    if (!Array.isArray(st[k])) (st as unknown as Record<string, unknown>)[k] = k === "buckets" ? d.buckets : [];
  st.timer ??= { state: "idle", elapsed_sec: 0 };
  st.meta = { ...d.meta, ...(s?.meta ?? {}), at_risk: s?.meta?.at_risk ?? [] };
  return st;
}

export class Store {
  state: State = defaultState();
  version = 0;
  status: SyncStatus = "offline";
  lastError = "";
  private pending: Mutation[] = [];
  private listeners = new Set<(s: State) => void>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private transport: Transport | null, private persist = true) {}

  subscribe(fn: (s: State) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() { for (const fn of this.listeners) fn(this.state); }

  async load(): Promise<void> {
    if (this.persist) {
      const saved = await kvGet<{ version: number; state: State; pending: number }>("doc");
      if (saved) { this.state = normalize(saved.state); this.version = saved.version; }
    }
    this.emit();
    await this.pull();
  }

  /** Runs after every local edit (and again when the edit is replayed on a newer relay copy).
   *  The engine uses it to re-plan whenever a planner input changed. */
  afterMutate: Mutation | null = null;

  /** Apply a local edit now; it is pushed to the relay in the background. */
  update(fn: Mutation): void {
    const m: Mutation = (st) => { fn(st); this.afterMutate?.(st); };
    m(this.state);
    this.pending.push(m);
    this.save();
    this.emit();
    void this.flush();
  }

  private save() {
    if (this.persist) void kvSet("doc", { version: this.version, state: this.state });
  }

  /** Fetch the relay's document. Pending local edits are replayed on top of it. */
  async pull(): Promise<boolean> {
    if (!this.transport) return false;
    try {
      this.status = "syncing";
      const r = await this.transport.get();
      if (r.version === this.version && !this.pending.length) { this.status = "synced"; this.emit(); return false; }
      if (r.version !== this.version) {
        const next = normalize(r.state);
        for (const fn of this.pending) fn(next);
        this.state = next;
        this.version = r.version;
        this.save();
      }
      this.status = "synced";
      this.emit();
      if (this.pending.length) await this.flush();
      return true;
    } catch (e) {
      this.status = "offline";
      this.lastError = String(e);
      this.emit();
      return false;
    }
  }

  flush(): Promise<void> {
    if (!this.transport || !this.pending.length) return Promise.resolve();
    if (this.flushing) return this.flushing.then(() => this.flush());
    this.flushing = (async () => {
      for (let attempt = 0; attempt < 4 && this.pending.length; attempt++) {
        const sent = this.pending.length;
        try {
          this.status = "syncing";
          const r = await this.transport!.put(this.version, this.state);
          if (r.ok) {
            this.version = r.version;
            this.pending = this.pending.slice(sent);
            this.status = "synced";
          } else { // someone else (MCP, another tab) wrote first: rebase our edits
            const next = normalize(r.state);
            for (const fn of this.pending) fn(next);
            this.state = next;
            this.version = r.version;
          }
          this.save();
        } catch (e) {
          this.status = "offline";
          this.lastError = String(e);
          break;
        }
      }
      this.emit();
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Poll so MCP edits from Claude show up within a few seconds. */
  startPolling(ms = 20000): void {
    this.stopPolling();
    this.timer = setInterval(() => void this.pull(), ms);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", () => { if (!document.hidden) void this.pull(); });
  }

  stopPolling(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** Small API helper for the relay's non-sync endpoints. */
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const t = localStorage.getItem("relay_token");
  if (t) h["X-Relay-Token"] = t;
  const r = await fetch(path, body === undefined ? { headers: h } : { method: "POST", headers: h, body: JSON.stringify(body) });
  const text = await r.text();
  let j: unknown = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error((j as { error?: string })?.error ?? `${path} ${r.status}`);
  return j as T;
}
