"""Check which Chromium flag set exposes the GPU to WebGPU."""
import asyncio, json, sys
from playwright.async_api import async_playwright

JS = """async () => { if (!navigator.gpu) return 'no navigator.gpu';
  const a = await navigator.gpu.requestAdapter({powerPreference:'high-performance'}); if (!a) return 'no adapter';
  const i = a.info || {}; return JSON.stringify({vendor:i.vendor, arch:i.architecture, desc:i.description,
  f16:a.features.has('shader-f16'), maxBuf:a.limits.maxBufferSize, maxBind:a.limits.maxStorageBufferBindingSize}); }"""

SETS = {
  "headless-vulkan": (True, ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=vulkan", "--ignore-gpu-blocklist"]),
  "headless-new-vulkan": (True, ["--headless=new", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--ignore-gpu-blocklist", "--disable-vulkan-surface"]),
  "headed-vulkan": (False, ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan", "--ignore-gpu-blocklist"]),
}

async def main():
    async with async_playwright() as p:
        for name, (headless, args) in SETS.items():
            if name.startswith("headed") and len(sys.argv) < 2:
                continue
            try:
                b = await p.chromium.launch(headless=headless, args=args)
                pg = await b.new_page()
                await pg.goto("http://127.0.0.1:8000/healthz")
                print(name, "->", await pg.evaluate(JS))
                await b.close()
            except Exception as e:
                print(name, "-> error", str(e)[:200])

asyncio.run(main())
