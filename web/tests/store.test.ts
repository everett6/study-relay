import { describe, expect, it } from "vitest";
import { normalize, Store, type Transport } from "../src/core/store";
import { defaultState, type State } from "../src/core/types";

function fakeRelay() {
  let version = 1;
  let doc: State = defaultState();
  const t: Transport = {
    async get() { return { version, state: structuredClone(doc) }; },
    async put(base, state) {
      if (base !== version) return { ok: false, version, state: structuredClone(doc) };
      doc = structuredClone(state); version++;
      return { ok: true, version };
    },
  };
  return { t, write(fn: (s: State) => void) { fn(doc); version++; }, get doc() { return doc; } };
}

describe("store sync", () => {
  it("adds the Self-improvement goal when normalizing older saved state", () => {
    const old = defaultState();
    old.buckets = old.buckets.filter((b) => b.key !== "SELF");
    old.buckets[0].target_hours = 7;

    const migrated = normalize(old);
    expect(migrated.buckets.find((b) => b.key === "SELF")).toMatchObject({ name: "Self-improvement", target_hours: 2 });
    expect(migrated.buckets[0].target_hours).toBe(7);
    expect(normalize(migrated).buckets.filter((b) => b.key === "SELF")).toHaveLength(1);
  });

  it("rebases local edits on a 409 instead of dropping either side", async () => {
    const relay = fakeRelay();
    const store = new Store(relay.t, false);
    await store.load();
    relay.write((s) => s.events.push({ id: "mcp", title: "Banquet (from Claude)", kind: "event", start: "2026-11-19T19:00", end: "2026-11-19T21:00" }));
    store.update((s) => { s.buckets[0].target_hours = 9; });
    await store.flush();
    expect(relay.doc.events.map((e) => e.id)).toEqual(["mcp"]);
    expect(relay.doc.buckets[0].target_hours).toBe(9);
    expect(store.state.events).toHaveLength(1);
    expect(store.status).toBe("synced");
  });
  it("keeps working offline and queues edits", async () => {
    const store = new Store({ get: () => Promise.reject(new Error("down")), put: () => Promise.reject(new Error("down")) }, false);
    await store.load();
    store.update((s) => { s.buckets[1].target_hours = 2; });
    await store.flush();
    expect(store.status).toBe("offline");
    expect(store.state.buckets[1].target_hours).toBe(2);
  });
});
