// 驱动层集成自测：用正式 WebApiDriver 跑一次对话（真浏览器）
// 运行: bun run src/spike/driver-live.ts [thinking|search]

import { parseConfig } from "../config";
import { launchChatBrowser } from "../browser/launcher";
import { checkLogin, waitForLogin } from "../browser/auth";
import { WebApiDriver } from "../driver/web-api";
import type { BridgeState } from "../server/app";

const mode = Bun.argv[2] ?? "chat";
const config = parseConfig(Bun.argv.slice(2));
const { context, page } = await launchChatBrowser(config);

try {
    if(!(await checkLogin(page))) {
        const state: BridgeState = {
            status: "WAIT_LOGIN",
            startedAt: Date.now(),
            lastError: null,
        };
        await waitForLogin(page, state);
    }

    const prompt =
        mode === "thinking" ? "用一句话推理：9.11 和 9.9 哪个大？" :
        mode === "search" ? "用一句话回答：DeepSeek 最近发布了什么新模型？" :
        "用一句话回答：1+1等于几？";

    const driver = new WebApiDriver(page);
    const t0 = performance.now();
    const outcome = await driver.chat({
        prompt,
        thinking: mode === "thinking",
        search: mode === "search",
    });

    console.log(`\n===== driver OK：${(performance.now() - t0).toFixed(0)}ms =====`);
    console.log("text     :", outcome.text);
    console.log("reasoning:", outcome.reasoning.length > 0 ? outcome.reasoning.slice(0, 80) + "…" : "(none)");
    console.log("tokens   :", outcome.completionTokens);
    console.log("status   :", outcome.finished ? "FINISHED" : "??", outcome.closed ? "+ closed" : "");
    console.log("title    :", outcome.title);
} finally {
    await context.close();
}
