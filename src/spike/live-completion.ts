// S3c: 真服务器端到端 —— 建会话 → 取挑战 → 进程内求解 → 发 completion → 打印 SSE
// 运行: bun run src/spike/live-completion.ts

import { chromium } from "patchright";

// ===== 1. 进程内 wasm 求解器（与 pow-solve.ts 相同） =====

const wasmBytes = await Bun.file("assets/sha3_wasm_bg.wasm").arrayBuffer();
const { instance } = await WebAssembly.instantiate(wasmBytes, {});

type WasmExports = {
    memory: WebAssembly.Memory;
    wasm_solve: (retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number) => void;
    __wbindgen_add_to_stack_pointer: (delta: number) => number;
    __wbindgen_export_0: (size: number, align: number) => number;
};
const ex = instance.exports as WasmExports;
const encoder = new TextEncoder();

function solve(challenge: string, prefix: string, difficulty: number): number | null {
    const cb = encoder.encode(challenge);
    const pb = encoder.encode(prefix);
    const cPtr = ex.__wbindgen_export_0(cb.length, 1) >>> 0;
    const pPtr = ex.__wbindgen_export_0(pb.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer, cPtr, cb.length).set(cb);
    new Uint8Array(ex.memory.buffer, pPtr, pb.length).set(pb);
    const retptr = ex.__wbindgen_add_to_stack_pointer(-16) >>> 0;
    ex.wasm_solve(retptr, cPtr, cb.length, pPtr, pb.length, difficulty);
    const view = new DataView(ex.memory.buffer);
    const ok = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    ex.__wbindgen_add_to_stack_pointer(16);
    return ok === 0 ? null : answer;
}

// ===== 2. 浏览器 =====

const context = await chromium.launchPersistentContext("./.deepseek-profile", {
    channel: "msedge",
    headless: false,
    chromiumSandbox: true,
    args: ["--test-type"],
});
const page = context.pages()[0] ?? (await context.newPage());

try {
    await page.goto("https://chat.deepseek.com/");

    // 等登录态
    let token: string | null = null;
    for (let i = 0; i < 20 && !token; i++) {
        token = await page.evaluate(() => {
            const raw = localStorage.getItem("userToken");
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                return typeof parsed?.value === "string" && parsed.value.length > 0 ? parsed.value : null;
            } catch {
                return null;
            }
        });
        if (!token) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!token) throw new Error("未检测到登录态");
    console.log("✅ 登录态 OK，token:", token.slice(0, 8) + "…");

    // ===== 3. 建会话 + 取挑战（页面内 fetch，手动带 authorization） =====

    const boot = await page.evaluate(async (tok: string) => {
        const H = { "content-type": "application/json", authorization: "Bearer " + tok };

        const sRes = await fetch("/api/v0/chat_session/create", { method: "POST", headers: H, body: "{}" });
        const sJson = await sRes.json();
        const biz = sJson?.data?.biz_data;
        const sessionId = biz?.chat_session?.id ?? biz?.id ?? null;
        
        const cRes = await fetch("/api/v0/chat/create_pow_challenge", {
            method: "POST",
            headers: H,
            body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
        });
        const cJson = await cRes.json();
        const challenge = cJson?.data?.biz_data?.challenge ?? null;

        return { sessionStatus: sRes.status, sessionId, challengeStatus: cRes.status, challenge };
    }, token);

    if (!boot.sessionId || !boot.challenge) {
        throw new Error("建会话/取挑战失败: " + JSON.stringify(boot));
    }
    const ch = boot.challenge as {
        algorithm: string; challenge: string; salt: string; signature: string;
        difficulty: number; expire_at: number;
    };
    console.log("✅ 新会话:", boot.sessionId);
    console.log(`✅ 挑战: algorithm=${ch.algorithm} difficulty=${ch.difficulty} expire_at=${ch.expire_at}`);

    // ===== 4. 进程内求解 =====

    const prefix = `${ch.salt}_${ch.expire_at}_`;
    const t0 = performance.now();
    const answer = solve(ch.challenge, prefix, ch.difficulty);
    if (answer === null) throw new Error("PoW 求解失败");
    console.log(`✅ 解出 answer=${answer}（${(performance.now() - t0).toFixed(1)}ms）`);

    const powHeader = Buffer.from(JSON.stringify({
        algorithm: ch.algorithm,
        challenge: ch.challenge,
        salt: ch.salt,
        answer,
        signature: ch.signature,
        target_path: "/api/v0/chat/completion",
    })).toString("base64");

    // ===== 5. 发 completion，页面内读完整条 SSE =====

    const t1 = performance.now();
    const out = await page.evaluate(async (arg: { token: string; sessionId: string; powHeader: string }) => {
        const res = await fetch("/api/v0/chat/completion", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer " + arg.token,
                "x-ds-pow-response": arg.powHeader,
            },
            body: JSON.stringify({
                chat_session_id: arg.sessionId,
                parent_message_id: null,
                model_type: "default",
                prompt: "用一句话回答：1+1等于几？",
                ref_file_ids: [],
                thinking_enabled: false,
                search_enabled: false,
                action: null,
                preempt: false,
            }),
        });

        const status = res.status;
        const ct = res.headers.get("content-type");
        if (!res.body) return { status, ct, text: "" as string };

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline && text.length < 500000) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.includes("event: close")) break;
        }
        try { await reader.cancel(); } catch {}
        return { status, ct, text };
    }, { token, sessionId: boot.sessionId, powHeader });

    const totalMs = (performance.now() - t1).toFixed(0);
    console.log(`\n===== completion: HTTP ${out.status} (${out.ct}) · ${out.text.length} 字符 · ${totalMs}ms =====`);
    const lines = out.text.split("\n");
    console.log(lines.slice(0, 100).join("\n"));
    if (lines.length > 100) console.log(`…（还有 ${lines.length - 100} 行）`);

    const ok = out.text.includes('"FINISHED"') && out.text.includes("event: close");
    if (ok) {
        await Bun.write("tests/fixtures/completion-live-sample.txt", out.text);
        console.log("\n🎉 端到端打通！SSE 原文已存 tests/fixtures/completion-live-sample.txt");
    } else {
        console.log("\n⚠️ 未看到 FINISHED + close，检查上面的原始响应");
    }
} finally {
    await context.close();
}