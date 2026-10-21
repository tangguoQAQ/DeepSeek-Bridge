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

test("tools 请求：规范化工具定义与默认 tool_choice", () => {
    const r = parseChatRequest({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
        tools: [{
            type: "function",
            function: {
                name: "get_weather",
                description: "查天气",
                parameters: { type: "object", properties: { city: { type: "string" } } }
            }
        }],
    });
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]!.function.name).toBe("get_weather");
    expect(r.toolChoice).toBe("auto");
    expect(r.parallelToolCalls).toBe(true);
});

test("tool_choice：required 无工具、未知工具名 → 400", () => {
    const base = {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
    };
    expect(() => parseChatRequest({ ...base, tool_choice: "required" })).toThrow(ApiError);
    expect(() => parseChatRequest({
        ...base,
        tools: [{ type: "function", function: { name: "a" } }],
        tool_choice: { type: "function", function: { name: "b" } },
    })).toThrow(/unknown tool/);
});

test("assistant tool_calls + tool 消息：参数归一为紧凑 JSON", () => {
    const r = parseChatRequest({
        model: "deepseek-chat",
        messages: [
            { role: "user", content: "查天气" },
            {
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: "{ \"city\": \"北京\" }" }
                }]
            },
            { role: "tool", content: "晴", tool_call_id: "call_1" },
        ],
    });
    expect(r.messages[1]).toEqual({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"北京\"}" }]
    });
    expect(r.messages[2]).toEqual({ role: "tool", content: "晴", toolCallId: "call_1" });
});

test("tool 消息缺 tool_call_id、非 assistant 带 tool_calls → 400", () => {
    const base = { model: "deepseek-chat" };
    expect(() => parseChatRequest({
        ...base,
        messages: [{ role: "tool", content: "晴" }],
    })).toThrow(/tool_call_id/);
    expect(() => parseChatRequest({
        ...base,
        messages: [{ role: "user", content: "hi", tool_calls: [] }],
    })).toThrow(/assistant/);
});

test("旧版 functions → 400", () => {
    expect(() => parseChatRequest({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
        functions: [],
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
