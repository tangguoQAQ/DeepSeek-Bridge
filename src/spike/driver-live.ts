// 驱动层集成自测：用正式 WebApiDriver 跑一次对话（真浏览器，流式打印）
// 运行: bun run src/spike/driver-live.ts [thinking|search]

import { parseConfig } from "../config";
import { launchChatBrowser } from "../browser/launcher";
import { checkLogin, waitForLogin } from "../browser/auth";
import { WebApiDriver } from "../driver/web-api";
import type { BridgeState } from "../server/app";
import type { CompletionOutcome } from "../protocol/patch-stream";

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
    let firstEventAt: number | null = null;
    let outcome: CompletionOutcome | null = null;

    for await (const event of driver.chat({
        prompt,
        thinking: mode === "thinking",
        search: mode === "search",
    })) {
        if(event.type === "text") {
            if(firstEventAt === null) {
                firstEventAt = performance.now();
            }
            process.stdout.write(event.text);
        } else if(event.type === "reasoning") {
            if(firstEventAt === null) {
                firstEventAt = performance.now();
            }
            process.stdout.write(`\x1b[90m${event.text}\x1b[0m`);
        } else {
            outcome = event.outcome;
        }
    }

    const elapsed = (performance.now() - t0).toFixed(0);
    const first = firstEventAt === null ? "-" : (firstEventAt - t0).toFixed(0) + "ms";
    console.log(`\n===== driver OK：${elapsed}ms（首事件 ${first}）=====`);
    console.log("text     :", outcome?.text ?? "(none)");
    console.log("reasoning:", outcome !== null && outcome.reasoning.length > 0 ? outcome.reasoning.slice(0, 80) + "…" : "(none)");
    console.log("tokens   :", outcome?.completionTokens ?? 0);
    console.log("status   :", outcome?.finished ? "FINISHED" : "??", outcome?.closed ? "+ closed" : "");
    console.log("title    :", outcome?.title ?? "(none)");
} finally {
    await context.close();
}
