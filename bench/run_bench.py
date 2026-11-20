"""Head-to-head benchmark of the in-browser models on this machine's GPU (headless Chromium + WebGPU).

Starts the Vite dev server, opens bench.html once per model config, saves raw results to
bench/results/*.json and prints a summary. The browser profile in bench/.profile caches model
downloads between runs.
"""
import asyncio, json, os, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent
WEB = ROOT.parent / "web"
OUT = ROOT / "results"
# name, model, thinking, prefix KV cache
CONFIGS = [
    ("lfm3-fast", "onnx-community/LFM3-1.7B-ONNX", 0, 1),
    ("lfm3-fast-nocache", "onnx-community/LFM3-1.7B-ONNX", 0, 0),
    ("lfm3-thinking", "onnx-community/LFM3-1.7B-ONNX", 1, 1),
    ("qwen2.5-3b", "Qwen2.5-3B-Instruct-q4f16_1-MLC", 0, 1),
]
ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=vulkan", "--ignore-gpu-blocklist"]


def wait_http(url, secs=60):
    for _ in range(secs * 2):
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except Exception:
            time.sleep(0.5)
    return False


async def run_one(ctx, name, model, thinking, cache):
    page = await ctx.new_page()
    page.on("console", lambda m: m.type == "error" and print(f"  [{name} console] {m.text[:200]}", flush=True))
    await page.goto(f"http://127.0.0.1:5173/bench.html?model={model}&thinking={thinking}&cache={cache}")
    last, t0 = "", time.time()
    while True:
        try:
            done = await page.evaluate("window.benchPromise ? Promise.race([window.benchPromise.then(() => true), new Promise(r => setTimeout(() => r(false), 100))]) : false")
            status = await page.evaluate("window.benchStatus || ''")
        except Exception as e:  # Vite reloaded the page (dependency re-optimisation); the bench restarts itself
            print(f"  [{name}] page reloaded ({str(e)[:60]}), continuing", flush=True)
            await asyncio.sleep(3)
            continue
        if status != last:
            print(f"  [{name} {int(time.time() - t0)}s] {status}", flush=True)
            last = status
        if done:
            break
        if time.time() - t0 > 3 * 3600:
            print(f"  [{name}] timed out", flush=True)
            break
        await asyncio.sleep(5)
    res = await page.evaluate("window.benchPromise")
    await page.close()
    return res


def summary(name, r):
    if not r or r.get("error"):
        return f"{name:15s} ERROR {r and r.get('error')}"
    c, e, x = r["commands"], r["estimates"], r["extracts"]
    ms = sorted(i["ms"] for i in c)
    core = [i for i in c if i.get("set", "core") == "core"]
    keep = [i for i in c if i.get("set") == "keep"]
    asg = [i for i in c if i.get("set") == "assign"]
    toks = sorted(i.get("promptTokens") or 0 for i in c)
    app = (f"app {sum(i.get('appPass', False) for i in core)}/{len(core)}+{sum(i.get('appPass', False) for i in keep)}/{len(keep)}"
           f"+{sum(i.get('appPass', False) for i in asg)}/{len(asg)}  "
           if any("appPass" in i for i in c) else "")
    return (f"{name:18s} core {sum(i['pass'] for i in core):2d}/{len(core)}  keep {sum(i['pass'] for i in keep)}/{len(keep)}  assign {sum(i['pass'] for i in asg)}/{len(asg)}  {app}"
            f"valid {sum(i['parsed'] for i in c):2d}/{len(c)}  prompt ~{toks[len(toks)//2]} tok  "
            f"median {ms[len(ms)//2]/1000:.1f}s  max {ms[-1]/1000:.1f}s | estimates valid {sum(i['valid'] for i in e)}/7 "
            f"in-range {sum(i['inRange'] for i in e)}/7 type {sum(i['typeOk'] for i in e)}/7 | screenshot {sum(i['got'] for i in x)}/5 "
            f"| load {r['loadMs']/1000:.0f}s")


async def main():
    OUT.mkdir(exist_ok=True)
    only = set(sys.argv[1:])
    vite = subprocess.Popen(["npx", "vite", "--port", "5173", "--strictPort", "--host", "127.0.0.1"], cwd=WEB,
                            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        assert wait_http("http://127.0.0.1:5173/bench.html"), "vite did not start"
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(str(ROOT / ".profile"), headless=True, args=ARGS,
                                                             timezone_id="America/Los_Angeles")
            for name, model, thinking, cache in CONFIGS:
                if only and name not in only:
                    continue
                print(f"== {name}", flush=True)
                r = await run_one(ctx, name, model, thinking, cache)
                (OUT / f"{name}.json").write_text(json.dumps(r, indent=1))
                print(summary(name, r), flush=True)
            await ctx.close()
    finally:
        vite.terminate()
    print("\nSUMMARY")
    for name, *_ in CONFIGS:
        f = OUT / f"{name}.json"
        if f.exists():
            print(summary(name, json.loads(f.read_text())))


asyncio.run(main())
