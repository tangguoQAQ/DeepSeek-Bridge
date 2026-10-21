import { test, expect } from "bun:test";
import { runChatCompletion, runChatCompletionStream } from "../src/server/completions";
import { parseChatRequest } from "../src/server/openai-schema";
import { SerialQueue } from "../src/queue";
import { ApiError } from "../src/server/errors";
import type { ChatBackend, ChatOptions, ChatEvent } from "../src/driver/types";
import type { CompletionOutcome } from "../src/protocol/patch-stream";

const OUTCOME: CompletionOutcome = {
    text: "你好！",
    reasoning: "",
    completionTokens: 7,
    finished: true,
    closed: true,
    title: null,
    responseMessageId: 2,
};

function fakeBackend(over: {
    record?: ChatOptions[];
    events?: ChatEvent[];
    outcome?: Partial<CompletionOutcome>;
    error?: Error;
} = {}): ChatBackend {
    return {
        chat: async function*(opts) {
            over.record?.push(opts);
            if(over.error) {
                throw over.error;
            }
            if(over.events) {
                for(const event of over.events) {
                    yield event;
                }
                return;
            }
            yield { type: "text", text: "你好！" };
            yield { type: "done", outcome: { ...OUTCOME, ...over.outcome } };
        },
    };
}

function body(model = "deepseek-chat", content = "你好"): Record<string, unknown> {
    return {
        model,
        messages: [{ role: "user", content }],
    };
}

function parse(model = "deepseek-chat", extra: Record<string, unknown> = {}) {
    return parseChatRequest({ ...body(model), ...extra });
}

test("非流式响应结构 + usage", async () => {
    const payload = await runChatCompletion(
        parse(),
        new SerialQueue(4, 0),
        fakeBackend(),
        24000,
    );

    expect(payload.id.startsWith("chatcmpl-ds-")).toBe(true);
    expect(payload.object).toBe("chat.completion");
    expect(payload.model).toBe("deepseek-chat");
    expect(payload.choices[0]!.message.role).toBe("assistant");
    expect(payload.choices[0]!.message.content).toBe("你好！");
    expect(payload.choices[0]!.message.reasoning_content).toBeUndefined();
    expect(payload.choices[0]!.finish_reason).toBe("stop");
    expect(payload.usage.completion_tokens).toBe(7);
    expect(payload.usage.prompt_tokens).toBeGreaterThan(0);
    expect(payload.usage.total_tokens).toBe(payload.usage.prompt_tokens + 7);
});

test("reasoner：思考流并入 reasoning_content", async () => {
    const payload = await runChatCompletion(
        parse("deepseek-reasoner"),
        new SerialQueue(4, 0),
        fakeBackend({
            events: [
                { type: "reasoning", text: "用户问好，" },
                { type: "reasoning", text: "应友好回应。" },
                { type: "text", text: "你好呀！" },
                { type: "done", outcome: { ...OUTCOME, text: "你好呀！", reasoning: "用户问好，应友好回应。" } },
            ],
        }),
        24000,
    );

    expect(payload.model).toBe("deepseek-reasoner");
    expect(payload.choices[0]!.message.reasoning_content).toBe("用户问好，应友好回应。");
    expect(payload.choices[0]!.message.content).toBe("你好呀！");
});

test("模型映射：search / 未知模型宽容处理", async () => {
    const record: ChatOptions[] = [];
    const queue = new SerialQueue(4, 0);

    await runChatCompletion(parse("deepseek-search"), queue, fakeBackend({ record }), 24000);
    const unknown = await runChatCompletion(parse("gpt-4o"), queue, fakeBackend({ record }), 24000);

    expect(record[0]).toMatchObject({ prompt: expect.any(String), thinking: false, search: true });
    expect(record[0]!.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(record[1]!.thinking).toBe(false);
    expect(record[1]!.search).toBe(false);
    expect(unknown.model).toBe("gpt-4o");
});

test("驱动报错原样上抛，队列不卡死", async () => {
    const queue = new SerialQueue(4, 0);
    const err = new ApiError(401, "authentication_error", "未登录");

    await expect(runChatCompletion(parse(), queue, fakeBackend({ error: err }), 24000)).rejects.toThrow(ApiError);
    expect(queue.snapshot).toEqual({ active: 0, pending: 0 });

    const ok = await runChatCompletion(parse(), queue, fakeBackend(), 24000);
    expect(ok.choices[0]!.message.content).toBe("你好！");
});

test("未带 FINISHED 收尾：宽容返回已收内容", async () => {
    const payload = await runChatCompletion(
        parse(),
        new SerialQueue(4, 0),
        fakeBackend({ outcome: { finished: false } }),
        24000,
    );
    expect(payload.choices[0]!.message.content).toBe("你好！");
});

test("流式：chunk 顺序 role → reasoning → content → finish → [DONE]", async () => {
    const res = await runChatCompletionStream(
        parse("deepseek-reasoner", { stream: true }),
        new SerialQueue(4, 0),
        fakeBackend({
            events: [
                { type: "reasoning", text: "思考中。" },
                { type: "text", text: "答案是" },
                { type: "text", text: "2。" },
                { type: "done", outcome: { ...OUTCOME, text: "答案是2。", reasoning: "思考中。" } },
            ],
        }),
        24000,
    );

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const role = text.indexOf('"role":"assistant"');
    const think = text.indexOf('"reasoning_content":"思考中。"');
    const t1 = text.indexOf('"content":"答案是"');
    const t2 = text.indexOf('"content":"2。"');
    const fin = text.indexOf('"finish_reason":"stop"');
    const done = text.indexOf("data: [DONE]");
    expect(role).toBeGreaterThanOrEqual(0);
    expect(think).toBeGreaterThan(role);
    expect(t1).toBeGreaterThan(think);
    expect(t2).toBeGreaterThan(t1);
    expect(fin).toBeGreaterThan(t2);
    expect(done).toBeGreaterThan(fin);
    expect(text).not.toContain('"usage"');
});

test("流式：include_usage 在 [DONE] 前给 usage chunk", async () => {
    const res = await runChatCompletionStream(
        parse("deepseek-chat", { stream: true, stream_options: { include_usage: true } }),
        new SerialQueue(4, 0),
        fakeBackend(),
        24000,
    );

    const text = await res.text();
    const usage = text.indexOf('"usage"');
    const done = text.indexOf("data: [DONE]");
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(usage).toBeLessThan(done);
    expect(text).toContain('"completion_tokens":7');
});

test("流式：首字节前错误 → 直接拒绝（可按 HTTP 错误处理）", async () => {
    const queue = new SerialQueue(4, 0);
    const backend = fakeBackend({ error: new ApiError(401, "authentication_error", "未登录") });

    await expect(runChatCompletionStream(
        parse("deepseek-chat", { stream: true }),
        queue,
        backend,
        24000,
    )).rejects.toThrow(ApiError);
    expect(queue.snapshot).toEqual({ active: 0, pending: 0 });
});

test("流式：客户端取消 → 驱动收到 abort、队列释放", async () => {
    const queue = new SerialQueue(4, 0);
    let aborted = false;
    const backend: ChatBackend = {
        chat: async function*(opts, signal) {
            yield { type: "text", text: "部分" };
            await new Promise<void>((resolve) => {
                if(signal?.aborted) {
                    aborted = true;
                    resolve();
                    return;
                }
                signal?.addEventListener("abort", () => {
                    aborted = true;
                    resolve();
                }, { once: true });
            });
        },
    };

    const res = await runChatCompletionStream(parse("deepseek-chat", { stream: true }), queue, backend, 24000);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();

    for(let i = 0; i < 50 && !aborted; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(aborted).toBe(true);
    for(let i = 0; i < 50 && queue.snapshot.active !== 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(queue.snapshot).toEqual({ active: 0, pending: 0 });
});
