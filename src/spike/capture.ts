import { chromium } from "patchright";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const OUT_DIR = "tests/fixtures";
mkdirSync(OUT_DIR, { recursive: true });
const reportPath = `${OUT_DIR}/capture-report.txt`;
writeFileSync(reportPath, ""); // 每次运行重新开始记

const REDACT = new Set(["authorization", "cookie", "set-cookie", "x-settings-token"]); // 这些头永不落盘
const log = (line = "") => {
  console.log(line);
  appendFileSync(reportPath, line + "\n");
};

function short(u: string) {
  return u.replace("https://chat.deepseek.com", "");
}

// ---- 启动（与 spike 相同配置）----
const context = await chromium.launchPersistentContext("./.deepseek-profile", {
  channel: "msedge",
  headless: false,
  chromiumSandbox: true,
  args: ["--test-type"],
});
const page =
  context.pages().find((p) => p.url().includes("deepseek")) ?? (await context.newPage());

// ---- 抓请求 ----
page.on("request", (req) => {
  if (!req.url().includes("/api/v0/")) return;
  log(`\n>>> 请求 ${req.method()} ${short(req.url())}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers())) {
    headers[k] = REDACT.has(k.toLowerCase()) ? "<redacted>" : v;
  }
  log("headers: " + JSON.stringify(headers));
  const body = req.postData();
  if (body) log("body: " + body.slice(0, 800));
});

// ---- 抓响应（串行处理，保证报告顺序可读）----
let chain: Promise<void> = Promise.resolve();
page.on("response", (res) => {
  chain = chain.then(() => handleResponse(res));
});

async function handleResponse(res: import("patchright").Response) {
  const url = res.url();
  if (!url.includes("/api/v0/")) return;
  log(`\n<<< 响应 ${res.status()} ${short(url)} [${res.headers()["content-type"] ?? ""}]`);

  if (url.includes("/chat/completion")) {
    try {
      const text = await res.text();
      writeFileSync(`${OUT_DIR}/completion-sse-sample.txt`, text);
      log(`已保存流内容 → ${OUT_DIR}/completion-sse-sample.txt（${text.length} 字符）`);
      log("前 300 字符预览:\n" + text.slice(0, 300));
    } catch (e) {
      log("读取流内容失败: " + String(e));
    }
  } else {
    try {
      log("body: " + (await res.text()).slice(0, 300));
    } catch {}
  }
}

// ---- 开跑 ----
await page.goto("https://chat.deepseek.com/");
log("\n==== 现在请操作浏览器窗口 ====");
log('1) 等页面加载完（抓登录检测请求）');
log('2) 点 “新对话”');
log('3) 发一条消息： 你好');
log("4) 等回答完全结束，回终端按 Ctrl+C");

await new Promise(() => {}); // 挂住