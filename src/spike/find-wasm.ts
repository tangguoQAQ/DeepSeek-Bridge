import { chromium } from "patchright";
import { mkdirSync } from "node:fs";

const context = await chromium.launchPersistentContext("./.deepseek-profile", {
  channel: "msedge",
  headless: false,
  chromiumSandbox: true,
  args: ["--test-type"],
});
const page = context.pages().find((p) => p.url().includes("deepseek")) ?? (await context.newPage());
await page.goto("https://chat.deepseek.com/");
await page.waitForTimeout(3000);

// 1) 已加载资源里找 wasm（performance API）
let urls = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(".wasm")),
);
console.log("已加载资源中的 wasm:", urls.length ? urls : "（无）");

// 2) 没找到 → 翻 JS bundle 源码找线索
if (urls.length === 0) {
  const hints = await page.evaluate(async () => {
    const out = [];
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]")).map((s) => s.src);
    for (const src of scripts) {
      try {
        const t = await (await fetch(src)).text();
        const re = /[^"'\s]{0,90}\.wasm/g;
        for (const m of t.matchAll(re)) {
          out.push(`${src.split("/").pop()} -> ${m[0]}`);
          if (out.length >= 30) return out;
        }
      } catch {}
    }
    return out;
  });
  console.log("bundle 里的 wasm 线索:");
  for (const h of hints) console.log("  " + h);
  const full = hints.map((h) => h
    .match(/https?:\/\/[^"'\s]+\.wasm/)?.[0])
    .filter((x): x is string => x !== undefined);
  urls = [...new Set(full)];
}

// 3) 下载到 assets/
const url = urls[0];
if (url) {
  console.log("下载:", url);
  mkdirSync("assets", { recursive: true });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await Bun.write("assets/sha3_wasm_bg.wasm", res);
    const size = (await Bun.file("assets/sha3_wasm_bg.wasm").arrayBuffer()).byteLength;
    console.log(`✅ 已保存 assets/sha3_wasm_bg.wasm（${size} 字节）`);
  } catch (e) {
    console.log("下载失败:", String(e), "→ 把线索贴我，我来定 URL");
  }
} else {
  console.log("没找到 wasm URL——把上面的线索贴给我");
}

// 4) 顺手侦察 localStorage 键名（看 hif 是不是存本地）
console.log("localStorage 键名:", await page.evaluate(() => Object.keys(localStorage)));

await context.close();