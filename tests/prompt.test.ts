import { test, expect } from "bun:test";
import { buildPrompt, renderIncremental, renderMessage } from "../src/protocol/prompt";
import type { PromptMessage } from "../src/protocol/prompt";
import type { ToolDefinition } from "../src/protocol/tool-calls";

const system = (content: string) => ({ role: "system" as const, content });
const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

const weatherTool: ToolDefinition = {
    type: "function",
    function: {
        name: "get_weather",
        description: "查天气",
        parameters: { type: "object", properties: { city: { type: "string" } } }
    }
};

test("基本拼装：system 置顶、末尾是最后一条 user", () => {
    const { prompt, truncated } = buildPrompt([
        system("你是助手"),
        user("你好"),
        assistant("你好！"),
        user("1+1？"),
    ]);
    expect(prompt).toContain("[System] 你是助手");
    expect(prompt).toContain("[User] 你好");
    expect(prompt).toContain("[Assistant] 你好！");
    expect(prompt.endsWith("[User] 1+1？\n\n")).toBe(true);
    expect(truncated).toBe(false);
});

test("多条 system 合并置顶", () => {
    const { prompt } = buildPrompt([system("A"), system("B"), user("x")]);
    expect(prompt).toContain("[System] A\nB");
    expect(prompt.indexOf("[System]")).toBeLessThan(prompt.indexOf("[User] x"));
});

test("prefill：末尾是 assistant 时追加继续指令", () => {
    const { prompt } = buildPrompt([user("写个标题"), assistant("标题：")]);
    expect(prompt).toContain("[User] （请继续完成上一条助手消息）");
    expect(prompt.endsWith("（请继续完成上一条助手消息）\n\n")).toBe(true);
});

test("超预算从中间裁剪：保首轮与末尾", () => {
    const msgs = [system("sys"), user("第一问"), assistant("第一答")];
    for(let i = 0; i < 50; i++) {
        msgs.push(user(`问题${i} `.repeat(20)));
        msgs.push(assistant(`回答${i} `.repeat(20)));
    }
    msgs.push(user("最后一问"));

    const { prompt, truncated } = buildPrompt(msgs, 2000);
    expect(truncated).toBe(true);
    expect(prompt).toContain("……（截断部分）……");
    expect(prompt).toContain("[User] 第一问");
    expect(prompt.endsWith("[User] 最后一问\n\n")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(2200);
});

test("单条消息超预算：截断中间并保留结尾问题", () => {
    const tail = "最后的问题";
    const { prompt } = buildPrompt([user("啊".repeat(8000) + tail)], 3000);
    expect(prompt).toContain("……（截断部分）……");
    expect(prompt).toContain(tail);
    expect(prompt.endsWith(`${tail}\n\n`)).toBe(true);
});

test("工具结果超预算：保留末尾错误信息", () => {
    const history: PromptMessage[] = [
        user("执行检查"),
        {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "run", arguments: "{}" }]
        },
        {
            role: "tool",
            content: "日志 ".repeat(6000) + "错误码 E42",
            toolCallId: "call_1"
        }
    ];

    const { prompt } = buildPrompt(history, 3000);
    expect(prompt).toContain("……（截断部分）……");
    expect(prompt).toContain("错误码 E42");
    expect(prompt.endsWith("错误码 E42\n\n")).toBe(true);
});

test("system 过长时优先压缩 system，保留最近的工具调用与结果", () => {
    const history: PromptMessage[] = [
        system(`系统说明 ${"x".repeat(8000)} 尾部规则`),
        user("查天气"),
        {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"北京\"}" }]
        },
        { role: "tool", content: "晴，25°C", toolCallId: "call_1" }
    ];

    const { prompt, truncated } = buildPrompt(history, 6000);
    expect(truncated).toBe(true);
    expect(prompt).toContain("</tool_calls>");
    expect(prompt).toContain("[Tool result id=call_1] 晴，25°C");
    expect(prompt).toContain("尾部规则");
    expect(prompt.length).toBeLessThanOrEqual(6000);
});

test("工具结果后的追问：保留工具结果、回答和最后一条 user", () => {
    const history: PromptMessage[] = [
        system(`系统说明 ${"x".repeat(8000)}`),
        user("查天气"),
        {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"北京\"}" }]
        },
        { role: "tool", content: "晴，25°C", toolCallId: "call_1" },
        assistant("北京晴，25°C。"),
        user("适合跑步吗？")
    ];

    const { prompt } = buildPrompt(history, 6000);
    expect(prompt).toContain("[Tool result id=call_1] 晴，25°C");
    expect(prompt).toContain("[Assistant] 北京晴，25°C。");
    expect(prompt.endsWith("[User] 适合跑步吗？\n\n")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(6000);
});

test("截断 assistant 内容时保留其中的 tool_calls", () => {
    const message: PromptMessage = {
        role: "assistant",
        content: `说明 ${"x".repeat(5000)}`,
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }]
    };

    const { prompt } = buildPrompt([user("查天气"), message], 3000);
    expect(prompt).toContain("……（截断部分）……");
    expect(prompt).toContain("<tool_calls>");
    expect(prompt).toContain("\"name\":\"get_weather\"");
});

test("带 tools 时在 header 注入协议；不带则不注入", () => {
    const withTools = buildPrompt([user("查天气")], 8000, {
        tools: [weatherTool],
        toolChoice: "auto",
        parallelToolCalls: true
    });
    expect(withTools.prompt).toContain("## 工具调用");
    expect(withTools.prompt).toContain("get_weather");
    expect(withTools.prompt.indexOf("## 工具调用")).toBeLessThan(
        withTools.prompt.indexOf("[User] 查天气"));

    const without = buildPrompt([user("查天气")], 8000);
    expect(without.prompt).not.toContain("## 工具调用");
});

test("assistant tool_calls 与 tool 结果按历史格式渲染", () => {
    const history: PromptMessage[] = [
        user("查天气"),
        {
            role: "assistant",
            content: "",
            toolCalls: [{
                id: "call_1",
                name: "get_weather",
                arguments: "{\"city\":\"北京\"}"
            }]
        },
        { role: "tool", content: "晴，25°C", toolCallId: "call_1" },
        user("总结一下")
    ];
    const { prompt } = buildPrompt(history);
    expect(prompt).toContain("[Assistant] \n<tool_calls>");
    expect(prompt).toContain("\"name\":\"get_weather\"");
    expect(prompt).toContain("\"city\":\"北京\"");
    expect(prompt).toContain("[Tool result id=call_1] 晴，25°C");
    expect(prompt.endsWith("[User] 总结一下\n\n")).toBe(true);
});

test("renderIncremental：只渲染新增消息", () => {
    const message: PromptMessage = {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }]
    };
    expect(renderIncremental([user("继续")])).toBe("[User] 继续");
    expect(renderIncremental([{ role: "tool", content: "晴", toolCallId: "call_1" }]))
        .toBe("[Tool result id=call_1] 晴");
    expect(renderMessage(message)).toContain("</tool_calls>");
});
