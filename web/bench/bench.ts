// Runs the fixed benchmark against one model in this browser. Driven by study-relay/bench/run_bench.py.
import { LLMClient } from "../src/ai/llmClient";
import { ASSIGN_CASES, CASES, ESTIMATES, EXTRACTS, KEEP_CASES, NOW, buildPlannedState, buildState, scoreExtract } from "./cases";

const q = new URLSearchParams(location.search);
const model = q.get("model") ?? "";
const thinking = q.get("thinking") === "1";
const cache = q.get("cache") !== "0";
const log = (m: string) => { document.getElementById("log")!.textContent += m + "\n"; (window as unknown as { benchStatus: string }).benchStatus = m; };

async function run() {
  const llm = new LLMClient((s) => { if (s.state === "loading") (window as unknown as { benchStatus: string }).benchStatus = `loading ${Math.round(s.progress * 100)}% ${s.text}`; });
  const t0 = performance.now();
  const ok = await llm.load(model, { thinking, prefixCache: cache });
  const loadMs = performance.now() - t0;
  if (!ok) return { model, thinking, error: llm.status.text };
  log(`loaded in ${(loadMs / 1000).toFixed(1)}s`);

  // warm-up (first GPU call compiles shaders)
  await llm.command("hi", buildPlannedState(), NOW, { fallback: false });

  const commands = [];
  for (const [set, c] of [...CASES.map((c) => ["core", c] as const), ...KEEP_CASES.map((c) => ["keep", c] as const), ...ASSIGN_CASES.map((c) => ["assign", c] as const)]) {
    const s = buildPlannedState();
    const t = performance.now();
    const r = await llm.command(c.text, s, NOW, { fallback: true });
    const ms = performance.now() - t;
    const pass = c.check(r.modelCalls, s);   // model alone (after the intent check)
    const appPass = c.check(r.calls, s);     // what the app runs: rules + model
    commands.push({ set, text: c.text, expect: c.expect, pass, appPass, ms: Math.round(ms), promptTokens: llm.lastPromptTokens, calls: r.modelCalls, appCalls: r.calls, parsed: r.modelCalls.length > 0, raw: llm.lastRaw.slice(0, 1500) });
    log(`${pass ? "PASS" : "fail"} ${Math.round(ms)}ms ${llm.lastPromptTokens}tok  ${c.text}${pass ? "" : "  RAW: " + llm.lastRaw.slice(0, 220).replace(/\n/g, " ")}`);
  }

  const estimates = [];
  for (const t of buildState().tasks) {
    const tt = performance.now();
    const e = await llm.estimate(t);
    const want = ESTIMATES[t.id];
    estimates.push({ id: t.id, title: t.title, minutes: e.minutes, type: e.task_type, load: e.cognitive_load, valid: e.source === "llm",
      inRange: e.source === "llm" && e.minutes >= want.lo && e.minutes <= want.hi, typeOk: e.source === "llm" && e.task_type === want.type,
      ms: Math.round(performance.now() - tt), raw: llm.lastRaw.slice(0, 600) });
    log(`estimate ${t.title}: ${e.minutes}m ${e.task_type} (${e.source})`);
  }

  const extracts = [];
  for (const c of EXTRACTS) {
    const tt = performance.now();
    const found = await llm.extract(c.text, NOW);
    extracts.push({ got: scoreExtract(found, c), of: c.want.length, found, ms: Math.round(performance.now() - tt), raw: llm.lastRaw.slice(0, 1200) });
  }
  const res = { model, thinking, cache, loadMs: Math.round(loadMs), commands, estimates, extracts };
  log("DONE");
  return res;
}

(window as unknown as { benchPromise: Promise<unknown> }).benchPromise = run().catch((e) => ({ model, thinking, error: String(e) }));
