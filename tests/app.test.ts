import { test, expect } from "bun:test";
import { createApp } from "../src/server/app";
import { SerialQueue } from "../src/queue";
import type { BridgeConfig } from "../src/config";
import type { BridgeState } from "../src/server/app";
import type { ChatBackend } from "../src/driver/types";

const config: BridgeConfig = {
    port: 7638,
    host: "127.0.0.1",
    token: null,
    profileDir: "./.deepseek-profile",
    headless: false,
    browserChannel: "auto",
    minRequestIntervalMs: 0,
    promptCharBudget: 24000,
    sessionReuse: true,
    maxSessions: 16,
};

function makeState(): BridgeState {
    return { status: "READY", startedAt: Date.now(), lastError: null };
}

const okBackend: ChatBackend = {
    chat: async function*() {
        yield { type: "text", text: "1+1等于2。" };
        yield {
            type: "done",
            outcome: {
                text: "1+1等于2。",
                reasoning: "",
                completionTokens: 48,
                finished: true,
                closed: true,
                title: "一加一等于二",
                responseMessageId: 2,
            },
        };
    },
};

const HEADERS = {
    host: "localhost:7638",
    "content-type": "application/json",
};

function post(app: ReturnType<typeof createApp>, body: string) {
    return app.request("http://localhost:7638/v1/chat/completions", {
        method: "POST",
        headers: HEADERS,
        body,
    });
}

test("POST /v1/chat/completions：200 + usage 头 + 内容", async () => {
    const app = createApp(config, makeState(), new SerialQueue(4, 0), () => okBackend);
    const res = await post(app, JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "1+1" }],
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-dsbridge-usage")).toBe("estimated");
    const payload = await res.json() as any;
    expect(payload.model).toBe("deepseek-chat");
    expect(payload.choices[0].message.content).toBe("1+1等于2。");
    expect(payload.usage.completion_tokens).toBe(48);
});

test("POST /v1/chat/completions stream=true：text/event-stream + [DONE]", async () => {
    const app = createApp(config, makeState(), new SerialQueue(4, 0), () => okBackend);
    const res = await post(app, JSON.stringify({
        model: "deepseek-chat",
        stream: true,
        messages: [{ role: "user", content: "1+1" }],
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"content":"1+1等于2。"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.indexOf("data: [DONE]")).toBeGreaterThan(text.indexOf('"finish_reason":"stop"'));
});

test("未就绪：backend 为 null → 503", async () => {
    const app = createApp(config, makeState(), new SerialQueue(4, 0), () => null);
    const res = await post(app, JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
    }));

    expect(res.status).toBe(503);
    const payload = await res.json() as any;
    expect(payload.error.type).toBe("api_error");
});

test("非法 JSON → 400", async () => {
    const app = createApp(config, makeState(), new SerialQueue(4, 0), () => okBackend);
    const res = await post(app, "{not json");

    expect(res.status).toBe(400);
    const payload = await res.json() as any;
    expect(payload.error.type).toBe("invalid_request_error");
});

test("Host 校验：陌生 Host → 403", async () => {
    const app = createApp(config, makeState(), new SerialQueue(4, 0), () => okBackend);
    const res = await app.request("http://localhost:7638/healthz", {
        headers: { host: "evil.example.com" },
    });

    expect(res.status).toBe(403);
});
