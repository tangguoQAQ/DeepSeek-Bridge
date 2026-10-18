import { test, expect } from "bun:test";
import { deltaChunk, finishChunk, usageChunk, SSE_DONE, SSE_PING } from "../src/server/sse";

function decode(chunk: string): any {
    expect(chunk.startsWith("data: ")).toBe(true);
    expect(chunk.endsWith("\n\n")).toBe(true);
    return JSON.parse(chunk.slice(6));
}

test("delta chunk：role / content / reasoning", () => {
    const role = decode(deltaChunk("chatcmpl-ds-x", 1, "deepseek-chat", { role: "assistant" }));
    expect(role.object).toBe("chat.completion.chunk");
    expect(role.model).toBe("deepseek-chat");
    expect(role.choices[0].delta).toEqual({ role: "assistant" });
    expect(role.choices[0].finish_reason).toBeNull();

    const content = decode(deltaChunk("chatcmpl-ds-x", 1, "deepseek-chat", { content: "你" }));
    expect(content.choices[0].delta).toEqual({ content: "你" });

    const reasoning = decode(deltaChunk("chatcmpl-ds-x", 1, "deepseek-reasoner", { reasoning_content: "想" }));
    expect(reasoning.choices[0].delta).toEqual({ reasoning_content: "想" });
});

test("finish chunk + 收尾常量", () => {
    const fin = decode(finishChunk("chatcmpl-ds-x", 1, "deepseek-reasoner"));
    expect(fin.choices[0].finish_reason).toBe("stop");
    expect(fin.choices[0].delta).toEqual({});
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
    expect(SSE_PING).toBe(": ping\n\n");
});

test("usage chunk：choices 为空", () => {
    const usage = decode(usageChunk("chatcmpl-ds-x", 1, "deepseek-chat", {
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7,
    }));
    expect(usage.choices).toEqual([]);
    expect(usage.usage.total_tokens).toBe(7);
});
