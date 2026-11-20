// Runs WebLLM inside a Web Worker so WebGPU inference never blocks the UI thread.
// The whole library lives only in this worker chunk; the page talks to it with small messages:
//   {id, type:"load", model} -> progress events, then {id, ok}
//   {id, type:"chat", request} -> {id, ok, content}
//   {id, type:"cached", model} -> {id, ok, cached}
import { CreateMLCEngine, hasModelInCache, type MLCEngine } from "@mlc-ai/web-llm";

let engine: MLCEngine | null = null;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
self.addEventListener("unhandledrejection", (ev) => {
  ev.preventDefault();
  post({ type: "error", error: String(ev.reason || "unhandled worker rejection") });
});

self.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data as { id: number; type: string };
  try {
    if (type === "load") {
      engine = await CreateMLCEngine(e.data.model, {
        initProgressCallback: (p) => post({ type: "progress", progress: p.progress, text: p.text }),
      }, {
        // smaller KV cache: the planner prompt is compressed to well under 2K tokens
        context_window_size: Math.max(1024, Number(e.data.contextTokens) || 2048) + 1024,
      });
      post({ id, ok: true });
    } else if (type === "chat") {
      if (!engine) throw new Error("model not loaded");
      const { enable_thinking, cache_prefix: _prefix, json_schema, ...req } = e.data.request as Record<string, unknown>;
      // WebLLM 0.2.x crashes on json_object without a schema ("Cannot pass non-string to std::string"),
      // so always pass one: the caller's (e.g. the planner's tool-call shape) or "any object".
      if ((req.response_format as { type?: string } | undefined)?.type === "json_object")
        req.response_format = { type: "json_object", schema: typeof json_schema === "string" ? json_schema : JSON.stringify({ type: "object" }) };
      // Qwen3-style reasoning switch goes through extra_body; other models ignore it.
      // WebLLM reuses the KV cache of the shared prefix between turns on its own.
      const r = await engine.chat.completions.create({ ...req, stream: false, extra_body: { enable_thinking: !!enable_thinking } } as never) as
        { choices: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number } };
      post({ id, ok: true, content: r.choices[0]?.message?.content ?? "", prompt_tokens: r.usage?.prompt_tokens ?? 0 });
    } else if (type === "cached") {
      post({ id, ok: true, cached: await hasModelInCache(e.data.model) });
    }
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};
