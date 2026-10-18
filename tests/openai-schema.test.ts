import { test, expect } from "bun:test";
import { parseChatRequest } from "../src/server/openai-schema";
import { ApiError } from "../src/server/errors";

test("正常请求：默认非流式", () => {
    const r = parseChatRequest({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
    });
    expect(r.stream).toBe(false);
    expect(r.maxTokens).toBe(null);
    expect(r.messages).toEqual([{ role: "user", content: "hi" }]);
});

test("tools 请求 → 400", () => {
    expect(() => parseChatRequest({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
    })).toThrow(ApiError);
});

test("image part → 400", () => {
    expect(() => parseChatRequest({
        model: "deepseek-chat",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }],
    })).toThrow(/image_url/);
});

test("content 多 part 拼接；developer 归一为 system", () => {
    const r = parseChatRequest({
        model: "deepseek-chat",
        messages: [
            { role: "developer", content: "规则" },
            { role: "user", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
        ],
    });
    expect(r.messages[0]).toEqual({ role: "system", content: "规则" });
    expect(r.messages[1]!.content).toBe("A\nB");
});
