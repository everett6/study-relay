# Study Relay

An adaptive study planner that runs in your browser, plus a tiny Go relay (under 30 MB of RAM) that can live on a Raspberry Pi 4B. The relay syncs your plan across devices, talks to Canvas, Discord and email, and exposes an MCP server so Claude can read and change your schedule.

```
browser (planner, CfC net, optional 3B LLM on WebGPU, voice, OCR)
   │  /api/sync  /api/canvas/proxy  /api/email/send …
   ▼
study-relay (Go, one static binary, SQLite)  ◄── MCP (Claude: /mcp, /mcp/sse)
   ├── Canvas REST (esuhsd.instructure.com)
   ├── Discord bot read + webhook post
   └── IMAP read / SMTP send (sends only drafts you approve)
```

## What it does

- **Today**: a momentum ring, your next block with a Start focus button, today's timeline with school, dinner and sleep shown, and rings for your weekly goals.
- **Week**: drag blocks to move them. Moved blocks are pinned and everything else re-plans around them.
- **Tasks**: the estimation matrix. AI or quick-guess minutes with confidence, a −/+ stepper to correct them (each correction trains the CfC net), difficulty dots, Focus and Done.
- **Inbox**: Discord club messages, counselor and club emails, and screenshots you add. Each one can become a task, an event or a reply draft. Drafts only go out when you press Send and confirm.
- **Ask bar**: type or talk. Some examples:
  - "I have a banquet at 7 tonight"
  - "what's my grade in bio?"
  - "any announcements for chemistry"
  - "start a focus session for AIME"
  - "email my counselor about a 1:1 this week"
  - "I'm so tired"
- **Voice mode** (mic button): talk to it directly. It answers out loud. Say "done" to close.
- **Screenshots**: paste one (Ctrl+V), drop one on the page, or use the camera button. The text is read in the browser and turned into tasks and events for you to check before they're added.
- **Adapts when you miss a mark**: a planned block that passes without a study session counts as missed. Its work is re-planned automatically. The app keeps a fast and a slow hit-rate average (your baseline), plus energy ratings and optional mood taps, and picks a workload mode:

  | Mode | When | Plan |
  |---|---|---|
  | 🚀 On a roll | about 90% of blocks hit, good energy | 50-min blocks |
  | 🌊 Steady | normal | 45-min blocks |
  | 🌤️ Stretched | hit rate below your baseline, low energy, or "meh" check-ins | 35-min blocks, 15-min breaks, goals 15% lighter |
  | 🫶 Taking it easier | 3+ misses in a row, or rough check-ins | 25-min blocks, goals 40% lighter, only due-soon schoolwork pushed |

  This is a workload signal, not a diagnosis. School deadlines and the 10:30 PM sleep cutoff are never moved.

## Install (clients)

Download the bundle for your machine from `release/` (`make release VERSION=x.y.z` builds them):

```bash
tar xzf study-relay-1.1.0-linux-amd64.tar.gz      # or -linux-arm64 for a Raspberry Pi
cd study-relay-1.1.0
cp .env.example .env && chmod 600 .env            # add your Canvas token; everything else is optional
./setup-integrations.sh                           # optional: Discord and email
./study-relay                                     # open http://localhost:8000
```

**Security defaults.** The relay listens on this computer only (`127.0.0.1:8000`). To reach it from your phone or other devices, set `RELAY_ADDR=:8000`. It then refuses requests without a token: it creates one next to the database on first start. Run `./study-relay pair http://<this-computer>:8000` and open the printed link once on each device; that signs the browser in. Your Canvas token, app passwords and the relay token never leave the relay or `.env`.

## Run locally

```bash
make test GO=go        # Go + web tests
make all GO=go         # build web into server/dist, then the binary
cd server && ../study-relay   # http://localhost:8000
```

Web development with hot reload (proxies `/api` to the relay on :8000):

```bash
cd web && npm run dev
```

## Configure (`server/.env`, chmod 600, never commit)

The easy way is the guided script. It walks you through Gmail, iCloud or Yahoo app passwords and a Discord bot and webhook, hides what you type, and writes only to `server/.env`:

```bash
./setup-integrations.sh
```

Restart the relay afterwards. Then use **Inbox → Test**: it signs in to each service without posting or sending anything and explains any problem. Port 465 (implicit TLS) and 587 (STARTTLS) both work for sending.

| Variable | Purpose |
|---|---|
| `CANVAS_BASE_URL` | `https://esuhsd.instructure.com` |
| `CANVAS_API_TOKEN` | lets the relay and the AI read your classes (grades, assignments, announcements, modules, syllabus) |
| `RELAY_ADDR` | default `127.0.0.1:8000` (this computer only). `:8000` makes it reachable from other devices and turns on the token |
| `RELAY_TOKEN` | shared secret. Empty + network address: one is generated (`study-relay pair` prints a sign-in link). Clients send `X-Relay-Token` or `Authorization: Bearer`. `RELAY_OPEN=1` disables the requirement (not recommended) |
| `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_IDS` | read club channels (bot needs the Read Message History permission and the Message Content intent) |
| `DISCORD_WEBHOOK_URL` | post your plan to a channel (`@everyone` is disabled) |
| `IMAP_ADDR`, `IMAP_USER`, `IMAP_PASSWORD` | e.g. `imap.gmail.com:993`. Use an app password, not your real password |
| `IMAP_FILTERS` | comma list; only matching senders or subjects are kept (e.g. `esuhsd.org,robotics,counselor`) |
| `COUNSELOR_KEYWORDS` | tags counselor mail (default `counselor,college,naviance,scholarship`) |
| `SMTP_ADDR`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | e.g. `smtp.gmail.com:587`. Used only by the Send button |
| `POLL_MINUTES` | Discord and email polling interval (default 10) |

## Raspberry Pi 4B over Tailscale

```bash
make web pi GO=go                      # produces study-relay-arm64
scp study-relay-arm64 study-relay.service server/.env pi@raspberrypi:~
# on the Pi
sudo useradd -r -s /usr/sbin/nologin study
sudo mkdir -p /opt/study-relay && sudo mv ~/study-relay-arm64 /opt/study-relay/study-relay
sudo mv ~/.env /opt/study-relay/.env && sudo chown -R study: /opt/study-relay && sudo chmod 600 /opt/study-relay/.env
sudo mv ~/study-relay.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now study-relay
tailscale serve --bg 8000              # https://raspberrypi.<tailnet>.ts.net
```

The unit file caps memory at 120 MB. The Go runtime is tuned with `GOMEMLIMIT=20MiB` and SQLite with `cache_size=-2000`.

## Connect Claude / Gemini (MCP)

Use [mcp-config.json](mcp-config.json) for Gemini CLI / Antigravity, or add to Claude Code:

```bash
claude mcp add --transport http study http://raspberrypi.<tailnet>.ts.net:8000/mcp
# if RELAY_TOKEN is set:
claude mcp add --transport http study http://…/mcp --header "Authorization: Bearer $RELAY_TOKEN"
```

Exposes **20 tools**, **4 resources** (`study://schedule/today`, `study://tasks/matrix`, `study://buckets/summary`, `study://rules`), and **4 prompts** (`plan_tonight`, `triage_inbox`, `exam_prep_plan`, `competition_coach`), including:
- Schedule & tasks: `get_schedule_and_buckets`, `get_week_overview`, `add_or_override_task`, `mark_task_done`, `manage_block`, `apply_event_override`, `control_study_timer`, `set_bucket_target`, `update_rules_and_breaks`
- Competition & research coach: `plan_competition_goal` (`AIME`, `USAAIO`, `RESEARCH`, `ACT`, `PHYSICS`), `get_study_resources`, `manage_research_milestone`
- Canvas, inbox & wellness: `canvas_explore`, `list_inbox`, `draft_email`, `check_in_mood`, `get_momentum_and_sessions`
- Institutional & compliance: `get_counselor_digest`, `apply_school_preset`, `get_audit_log`

## Linux Desktop App & Docker Hosting

- **Linux desktop app (with 32K-context native LFM via Ollama):**
  ```bash
  ./install-desktop-app.sh   # installs "Study Flow" to ~/.local/share/applications/
  ```
  Env vars for native local inference: `LOCAL_LLM_URL` (default `http://127.0.0.1:11434/v1`), `LOCAL_LLM_MODEL` (default `lfm2.5`), `LOCAL_LLM_CTX` (default `32768`), `LOCAL_LLM_API_KEY`. For gpt-6-luna through OpenRouter use URL `https://openrouter.ai/api/v1`, model `openai/gpt-6-luna` and your OpenRouter key (`OPENROUTER_API_KEY` also works).
- **Docker / VPS hosting:**
  ```bash
  docker compose up -d --build
  ```
  Institutional endpoints: `/api/presets`, `/api/presets/apply`, `/api/counselor/digest`, `/api/report/transcript`, `/api/export/json`, `/api/export/csv`, `/api/audit`, `/api/account/reset`.

## Smart AI (optional)

The ✨ chip loads a small language model on WebGPU inside a Web Worker. Pick one in the sheet:

- **Recommended:** LFM3 1.7B (Liquid, about 1.1 GB, runs through onnxruntime-web) and Qwen2.5 3B (about 2 GB, WebLLM).
- **Small & fast:** Qwen3.5 2B, Qwen3 1.7B, LFM2.5 1.2B, Llama 3.2 1B, Gemma 2 2B.
- **Bigger & smarter:** Qwen3.5 4B, Qwen3 4B, Llama 3.2 3B, Hermes 3 3B, Phi-3.5 mini, Qwen2.5 7B (needs a 6 GB+ GPU).
- **On this computer:** a native LFM served next to the relay (Ollama or llama-server), with no browser download.

Models with a reasoning mode get a "think before answering" switch. Each model downloads once and the browser keeps it (the app asks for persistent storage so it isn't evicted).

How the model is kept fast and small:

- **Context compression.** The planner prompt carries only today's and tomorrow's plan, the few tasks the message is about plus the ones due soonest, and short tool specs. Canvas data is stripped of ids, URLs and HTML before it reaches a prompt.
- **Prefix KV caching.** The instructions are identical for every message, so their key/value state is computed once and reused; only the new part of each prompt is processed. WebLLM does the same on its own, and its KV cache is capped at 3K tokens.
- **Weights** are 4-bit. LFM3's hybrid design (conv layers, sliding-window attention) keeps its KV cache small to begin with.

The model sees each block tagged **FIXED** (school, meals, sleep, events), **KEPT** (you pinned it) or **movable**. "Keep my AIME block" pins it (`keep_block`); "move research to Saturday" moves just that one thing (`move_block`). Any change, from chat, a drag, a Canvas sync, Settings or Claude over MCP, re-plans everything else around it.

Without a model, the rule parser and heuristic estimator handle everything, so the app works on any browser. `bench/run_bench.py` compares models on a fixed set of commands.

## Privacy

- Your Canvas token stays in `.env` on the relay. It is never written to the database or sent to the browser.
- Speech recognition uses the browser's speech service.
- Screenshot OCR runs in the browser. On the first screenshot, tesseract.js downloads its language data (about 10 MB) from a CDN. Chrome's built-in TextDetector is used when it's available.
- Email and Discord are never sent without a click: the AI drafts, you send.
