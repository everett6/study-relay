import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../src/ai/llmClient";
import { defaultState } from "../src/core/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function statusResponse(model: string, url: string): Response {
  return new Response(JSON.stringify({ ok: true, model, url, context_window: 128000 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("LLM model switching", () => {
  it("keeps the most recently requested relay model when status calls finish out of order", async () => {
    const pending: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal("fetch", vi.fn(() => {
      const request = deferred<Response>();
      pending.push(request);
      return request.promise;
    }));
    const client = new LLMClient();

    const older = client.load("native");
    const newer = client.load("native");
    pending[1].resolve(statusResponse("google/gemma-4-31b-it:free", "https://openrouter.ai/api/v1"));
    await expect(newer).resolves.toBe(true);
    pending[0].resolve(statusResponse("openai/gpt-6-luna", "https://openrouter.ai/api/v1"));
    await expect(older).resolves.toBe(false);

    expect(client.status).toMatchObject({
      state: "ready",
      model: "native",
      modelLabel: "google/gemma-4-31b-it:free",
      provider: "OpenRouter",
    });
  });

  it("does not reactivate a relay model after unload during its status request", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const client = new LLMClient();

    const loading = client.load("native");
    client.unload();
    pending.resolve(statusResponse("google/gemma-4-31b-it:free", "https://openrouter.ai/api/v1"));

    await expect(loading).resolves.toBe(false);
    expect(client.ready).toBe(false);
    expect(client.status.state).toBe("off");
  });

  it("sends restored conversation memory with requests to the relay model", async () => {
    let chatRequest: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/llm/status")
        return statusResponse("openai/gpt-6-luna", "https://openrouter.ai/api/v1");
      chatRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ content: JSON.stringify({ calls: [], reply: "Compare cost and fit." }) }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    const client = new LLMClient();
    const memory = [
      { role: "user" as const, content: "I like engineering and math." },
      { role: "assistant" as const, content: "We can compare engineering programs." },
    ];
    client.restoreHistory(memory);
    await client.load("native");
    await client.command("What should I compare?", defaultState(), new Date(2026, 10, 21), { fallback: false });

    const messages = chatRequest?.messages as { role: string; content: string }[];
    expect(messages.slice(-3)).toEqual([
      ...memory,
      { role: "user", content: "What should I compare?" },
    ]);
  });
});

describe("AI is the authoritative parser", () => {
  function relayClient(chatReply: unknown) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/llm/status")
        return statusResponse("openai/gpt-6-luna", "https://openrouter.ai/api/v1");
      return new Response(JSON.stringify({ content: JSON.stringify(chatReply) }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    return new LLMClient();
  }

  it("runs model tool calls even when the message has no rule keywords", async () => {
    const client = relayClient({
      calls: [{ tool: "add_event", args: { title: "Robotics", date: "2026-11-22", start: "16:00", end: "18:00" } }],
      reply: "Added robotics.",
    });
    await client.load("native");
    const out = await client.command("robotics saturday 4-6", defaultState(), new Date(2026, 10, 21));
    expect(out.via).toBe("llm");
    expect(out.calls).toEqual([
      { tool: "add_event", args: { title: "Robotics", date: "2026-11-22", start: "16:00", end: "18:00" } },
    ]);
  });

  it("keeps model calls for tools the rule parser would not have guessed", async () => {
    const client = relayClient({
      calls: [{ tool: "set_bucket_target", args: { bucket: "AIME", hours: 9 } }],
      reply: "Bumped AIME.",
    });
    await client.load("native");
    const out = await client.command("more math time please", defaultState(), new Date(2026, 10, 21));
    expect(out.calls.map((c) => c.tool)).toEqual(["set_bucket_target"]);
  });

  it("runs only what the model called, even when rules would have matched", async () => {
    const client = relayClient({ calls: [], reply: "Sure, sounds good." });
    await client.load("native");
    const out = await client.command("I have a banquet at 7 tonight", defaultState(), new Date(2026, 10, 21));
    // The rule parser would have said add_event, but the model answered without acting — so nothing runs.
    expect(out.calls).toEqual([]);
    expect(out.reply).toBe("Sure, sounds good.");
    expect(out.via).toBe("llm");
  });

  it("does not merge rule calls into a model turn", async () => {
    const client = relayClient({
      calls: [{ tool: "add_event", args: { title: "Banquet", date: "2026-11-21", start: "19:00", end: "21:00" } }],
      reply: "Added the banquet.",
    });
    await client.load("native");
    const out = await client.command("banquet at 7 tonight and finish the physics problem set before 6:30", defaultState(), new Date(2026, 10, 21));
    // Rules would have added preclear_task; the model is the only parser, so it does not appear.
    expect(out.calls.map((c) => c.tool)).toEqual(["add_event"]);
  });

  it("uses rules only when no model is loaded", async () => {
    const client = new LLMClient();
    expect(client.ready).toBe(false);
    const out = await client.command("I have a banquet at 7 tonight", defaultState(), new Date(2026, 10, 21));
    expect(out.via).toBe("rules");
    expect(out.calls.map((c) => c.tool)).toContain("add_event");
  });
});
