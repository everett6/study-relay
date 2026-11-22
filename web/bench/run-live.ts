// Live benchmark for the model you actually use (relay / OpenRouter / local).
// Unlike bench.ts (in-browser WebGPU models), this drives the real /api/llm/chat path and
// grades the *effect on the plan* plus whether answers are grounded in real state.
//
//   npx tsx bench/run-live.ts            # uses the relay on 127.0.0.1:8000
//   RELAY=http://raspberrypi.local:8000 RELAY_TOKEN=… npx tsx bench/run-live.ts
import { LLMClient } from "../src/ai/llmClient";
import { Engine } from "../src/app/engine";
import { Store } from "../src/core/store";
import type { State } from "../src/core/types";
import { CONTEXT_CASES, EFFECT_CASES, NOW, buildBenchState } from "./cases";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8000";
const TOKEN = process.env.RELAY_TOKEN ?? "";

/** Point the client's relative fetches at the relay under test. */
function installRelayFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? RELAY + input : input;
    const headers = new Headers(init?.headers);
    if (TOKEN) headers.set("X-Relay-Token", TOKEN);
    return real(url, { ...init, headers });
  }) as typeof fetch;
}

function freshState(): State {
  return buildBenchState();
}

/** Run one message through the real engine and return the resulting state. */
async function applyMessage(llm: LLMClient, text: string): Promise<{ before: State; after: State; reply: string; calls: string[] }> {
  const store = new Store(null, false);
  store.state = freshState();
  const engine = new Engine(store, llm, () => NOW);
  const before = structuredClone(store.state);
  const replies = await engine.run(text);
  return { before, after: store.state, reply: engine.lastReply || replies.map((r) => r.text).join(" "), calls: engine.lastTrace.filter((l) => l.startsWith("Action: ")).map((l) => l.slice(8)) };
}

async function main() {
  installRelayFetch();
  const llm = new LLMClient();
  const ok = await llm.load("native", { token: TOKEN });
  if (!ok) {
    console.error(`Could not reach the relay at ${RELAY}: ${llm.status.text}`);
    process.exit(1);
  }
  console.log(`Model: ${llm.status.provider} · ${llm.status.modelLabel}\n`);

  let effectPass = 0;
  console.log("SCHEDULE EDITING (graded on the resulting calendar)");
  for (const c of EFFECT_CASES) {
    const t0 = Date.now();
    const { before, after, calls } = await applyMessage(llm, c.text);
    const pass = c.check(after, before);
    if (pass) effectPass++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${String(Date.now() - t0).padStart(5)}ms  ${c.text}`);
    if (!pass) console.log(`        expected: ${c.expect}\n        tools: ${calls.join(", ") || "(none)"}`);
  }

  let ctxPass = 0;
  console.log("\nCONTEXT UNDERSTANDING (graded on whether the answer is grounded)");
  for (const c of CONTEXT_CASES) {
    const t0 = Date.now();
    const { after, reply } = await applyMessage(llm, c.text);
    const pass = c.check(reply, after);
    if (pass) ctxPass++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${String(Date.now() - t0).padStart(5)}ms  ${c.text}`);
    if (!pass) console.log(`        expected: ${c.expect}\n        reply: ${reply.slice(0, 200).replace(/\n/g, " ")}`);
  }

  const total = EFFECT_CASES.length + CONTEXT_CASES.length;
  const passed = effectPass + ctxPass;
  console.log(`\nSCORE  schedule ${effectPass}/${EFFECT_CASES.length}  context ${ctxPass}/${CONTEXT_CASES.length}  overall ${passed}/${total} (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

void main();
