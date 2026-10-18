import { test, expect } from "bun:test";
import { runChatCompletion } from "../src/server/completions";
import { SerialQueue } from "../src/queue";
import { ApiError } from "../src/server/errors";
import type { ChatBackend, ChatOptions } from "../src/driver/types";
import type { CompletionOutcome } from "../src/protocol/patch-stream";

function fakeBackend(over: {
    record?: ChatOptions[];
    outcome?: Partial<CompletionOutcome>;
    error?: Error;
} = {}): ChatBackend {
    return {
        chat: async (opts) => {
            over.record?.push(opts);
            if(over.error) {
                throw over.error;
            }
            return {
                text: "你好！",
                reasoning: "",
                completionTokens: 7,
                finished: true,
                closed: true,
                title: null,
                responseMessageId: 2,
                ...over.outcome,
            };
        },
    };
}

function body(model = "deepseek-chat", content = "你好"): unknown {
    return {
        model,
        messages: [{ role: "user", content }],
    };
}

test("非流式响应结构 + usage", async () => {
    const payload = await runChatCompletion(body(), new SerialQueue(4, 0), fakeBackend(), 24000);

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
        body("deepseek-reasoner"),
        new SerialQueue(4, 0),
        fakeBackend({ outcome: { reasoning: "用户问好，应友好回应。" } }),
        24000,
    );

    expect(payload.model).toBe("deepseek-reasoner");
    expect(payload.choices[0]!.message.reasoning_content).toBe("用户问好，应友好回应。");
});

test("模型映射：search / 未知模型宽容处理", async () => {
    const record: ChatOptions[] = [];
    const queue = new SerialQueue(4, 0);

    await runChatCompletion(body("deepseek-search"), queue, fakeBackend({ record }), 24000);
    const unknown = await runChatCompletion(body("gpt-4o"), queue, fakeBackend({ record }), 24000);

    expect(record[0]).toEqual({ prompt: expect.any(String), thinking: false, search: true });
    expect(record[1]!.thinking).toBe(false);
    expect(record[1]!.search).toBe(false);
    expect(unknown.model).toBe("gpt-4o");
});

test("驱动报错原样上抛，队列不卡死", async () => {
    const queue = new SerialQueue(4, 0);
    const err = new ApiError(401, "authentication_error", "未登录");

    await expect(runChatCompletion(body(), queue, fakeBackend({ error: err }), 24000)).rejects.toThrow(ApiError);
    expect(queue.snapshot).toEqual({ active: 0, pending: 0 });

    const ok = await runChatCompletion(body(), queue, fakeBackend(), 24000);
    expect(ok.choices[0]!.message.content).toBe("你好！");
});

test("未正常结束 → 504", async () => {
    await expect(runChatCompletion(
        body(),
        new SerialQueue(4, 0),
        fakeBackend({ outcome: { finished: false } }),
        24000,
    )).rejects.toThrow(ApiError);
});
