import { test, expect } from "bun:test";
import {
    ToolCallScanner,
    buildToolProtocol,
    hashTools,
    toolChoiceDirective
} from "../src/protocol/tool-calls";
import type { ToolDefinition } from "../src/protocol/tool-calls";

const weather: ToolDefinition = {
    type: "function",
    function: {
        name: "get_weather",
        description: "查天气",
        parameters: { type: "object", properties: { city: { type: "string" } } }
    }
};

function scan(chunks: string[], names: string[] = ["get_weather"]) {
    const scanner = new ToolCallScanner(names);
    let content = "";
    for(const chunk of chunks) {
        content += scanner.push(chunk);
    }
    const final = scanner.finish();
    content += final.content;
    return { content, toolCalls: final.toolCalls };
}

test("协议包含工具定义、调用格式与 choice 指令", () => {
    const protocol = buildToolProtocol([weather], "auto", true);
    expect(protocol).toContain("get_weather");
    expect(protocol).toContain("<tool_calls>");
    expect(protocol).toContain("</tool_calls>");
    expect(protocol).toContain("arguments");

    expect(buildToolProtocol([weather], "required", false))
        .toContain("恰好一个工具");
    expect(buildToolProtocol([weather], "required", false))
        .toContain("一次最多调用一个工具");
    expect(buildToolProtocol([weather], { type: "function", function: { name: "get_weather" } }, true))
        .toContain('必须调用工具 "get_weather"');
    expect(toolChoiceDirective("none")).toContain("禁止调用");
    expect(toolChoiceDirective("auto")).toBe("");
});

test("hashTools：空工具为空串；顺序无关；schema 变化会变", () => {
    expect(hashTools([])).toBe("");
    const a = hashTools([weather]);
    expect(hashTools([weather])).toBe(a);
    expect(hashTools([{ ...weather, function: { ...weather.function, description: "别的" } }])).not.toBe(a);
    expect(hashTools([
        weather,
        { type: "function", function: { name: "now" } }
    ])).toBe(hashTools([
        { type: "function", function: { name: "now" } },
        weather
    ]));
});

test("普通文本逐字通过；跨 chunk 的尖括号不误伤", () => {
    const result = scan(["你好", "，1 < 2", "，<", "br>"]);
    expect(result.content).toBe("你好，1 < 2，<br>");
    expect(result.toolCalls).toEqual([]);
});

test("解析完整工具块；content 保留前后文本", () => {
    const result = scan([
        "我查一下。\n<tool_calls>\n",
        '[{"name":"get_weather","arguments":{"city":"北京"}}]',
        "\n</tool_calls>\n多余"
    ]);
    expect(result.content.trim()).toBe("我查一下。\n\n多余");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.arguments).toBe("{\"city\":\"北京\"}");
    expect(result.toolCalls[0]!.id).toStartWith("call_");
});

test("标记被 chunk 切开也能解析", () => {
    const result = scan([
        "稍等<tool_",
        "calls>[{\"name\":\"get_weather\",\"arguments\":{\"city\":\"上海\"}}]</tool_",
        "calls>"
    ]);
    expect(result.content).toBe("稍等");
    expect(result.toolCalls[0]!.arguments).toBe("{\"city\":\"上海\"}");
});

test("支持 arguments 字符串、function 包装与代码围栏", () => {
    const wrapped = scan([
        "<tool_calls>```json\n",
        '[{"type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"广州\\"}"}}]',
        "\n```</tool_calls>"
    ]);
    expect(wrapped.toolCalls[0]!.arguments).toBe("{\"city\":\"广州\"}");
});

test("非法 JSON / 未知工具 / 非对象参数：原样当文本返回", () => {
    const malformed = scan(["<tool_calls>[{oops</tool_calls>"]);
    expect(malformed.toolCalls).toEqual([]);
    expect(malformed.content).toContain("<tool_calls>[{oops</tool_calls>");

    const unknown = scan(["<tool_calls>[{\"name\":\"rm_rf\",\"arguments\":{}}]</tool_calls>"]);
    expect(unknown.toolCalls).toEqual([]);
    expect(unknown.content).toContain("rm_rf");

    const nonObject = scan(["<tool_calls>[{\"name\":\"get_weather\",\"arguments\":\"x\"}]</tool_calls>"]);
    expect(nonObject.toolCalls).toEqual([]);

    const noneAllowed = scan(
        ["<tool_calls>[{\"name\":\"get_weather\",\"arguments\":{}}]</tool_calls>"],
        []
    );
    expect(noneAllowed.toolCalls).toEqual([]);
    expect(noneAllowed.content).toContain("<tool_calls>");
});

test("未闭合的工具块在 finish 时原样返回", () => {
    const result = scan(["答案<tool_calls>[{\"name\":\"get_weather\""]);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe("答案<tool_calls>[{\"name\":\"get_weather\"");
});

test("空数组与超过 8 个调用视为非法", () => {
    expect(scan(["<tool_calls>[]</tool_calls>"]).toolCalls).toEqual([]);
    const many = Array.from({ length: 9 }, () =>
        "{\"name\":\"get_weather\",\"arguments\":{}}").join(",");
    expect(scan([`<tool_calls>[${many}]</tool_calls>`]).toolCalls).toEqual([]);
});

const BAR = "\uFF5C";

// DeepSeek 官方格式：<｜DSML｜tool_calls> ...
function dsml(tag: string, attrs = "", closing = false): string {
    return `<${closing ? "/" : ""}${BAR}DSML${BAR}${tag}${attrs}>`;
}

// 客户端里出现的退化格式：双竖线 + 空格 + calls
function dsmlDegraded(tag: string, attrs = "", closing = false): string {
    return `<${closing ? "/" : ""}${BAR}${BAR}DSML${BAR}${BAR} ${tag}${attrs}>`;
}

test("DSML：官方 <｜DSML｜tool_calls> 格式", () => {
    const raw = [
        dsml("tool_calls"),
        dsml("invoke", ' name="get_weather"'),
        dsml("parameter", ' name="city" string="true"') + "北京" + dsml("parameter", "", true),
        dsml("invoke", "", true),
        dsml("tool_calls", "", true)
    ].join("\n");

    const result = scan([raw]);
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ city: "北京" });
});

test("DSML：双竖线 + calls + 多参数的退化格式", () => {
    const command = "$f='n:\\Projects\\DeepSeekBridge\\src\\server\\app.ts'; $lines=Get-Content -LiteralPath $f; $lines.Count";
    const raw = [
        dsmlDegraded("calls"),
        dsmlDegraded("invoke", ' name="powershell"'),
        dsmlDegraded("parameter", ' name="command" string="true"') + command + dsmlDegraded("parameter", "", true),
        dsmlDegraded("parameter", ' name="description" string="true"') + "Count lines in app.ts" + dsmlDegraded("parameter", "", true),
        dsmlDegraded("invoke", "", true),
        dsmlDegraded("calls", "", true)
    ].join("\n");

    const result = scan([raw], ["powershell"]);
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("powershell");
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({
        command,
        description: "Count lines in app.ts"
    });
});

test("DSML：多个 invoke、string=false 与非字符串参数", () => {
    const raw = [
        dsml("tool_calls"),
        dsml("invoke", ' name="get_weather"'),
        dsml("parameter", ' name="city" string="true"') + "北京" + dsml("parameter", "", true),
        dsml("invoke", "", true),
        dsml("invoke", ' name="get_weather"'),
        dsml("parameter", ' name="city" string="true"') + "上海" + dsml("parameter", "", true),
        dsml("parameter", ' name="count" string="false"') + "2" + dsml("parameter", "", true),
        dsml("invoke", "", true),
        dsml("tool_calls", "", true)
    ].join("");

    const calls = scan([raw]).toolCalls;
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ city: "北京" });
    expect(JSON.parse(calls[1]!.arguments)).toEqual({ city: "上海", count: 2 });
    expect(calls[0]!.id).not.toBe(calls[1]!.id);
});

test("DSML：开头/闭合标记跨 chunk 也能解析", () => {
    const raw = "稍等\n"
        + dsmlDegraded("calls")
        + dsmlDegraded("invoke", ' name="get_weather"')
        + dsmlDegraded("parameter", ' name="city" string="true"') + "广州" + dsmlDegraded("parameter", "", true)
        + dsmlDegraded("invoke", "", true)
        + dsmlDegraded("calls", "", true)
        + "\n好了";

    const chunks: string[] = [];
    for(let i = 0; i < raw.length; i += 7) {
        chunks.push(raw.slice(i, i + 7));
    }
    const result = scan(chunks);
    expect(result.content.trim()).toBe("稍等\n\n好了");
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ city: "广州" });
});

test("DSML：ASCII 双竖线与单引号属性", () => {
    const raw = "<||DSML||tool_calls>"
        + "<||DSML||invoke name='get_weather'>"
        + "<||DSML||parameter name='city' string='true'>深圳</||DSML||parameter>"
        + "</||DSML||invoke>"
        + "</||DSML||tool_calls>";

    const result = scan([raw]);
    expect(result.content).toBe("");
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ city: "深圳" });
});

test("DSML：未知工具/未闭合块原样当文本返回", () => {
    const unknown = scan([
        dsml("tool_calls"),
        dsml("invoke", ' name="rm_rf"'),
        dsml("invoke", "", true),
        dsml("tool_calls", "", true)
    ], ["get_weather"]);
    expect(unknown.toolCalls).toEqual([]);
    expect(unknown.content).toContain("rm_rf");

    const open = dsml("tool_calls") + dsml("invoke", ' name="get_weather"');
    const unclosed = scan([open]);
    expect(unclosed.toolCalls).toEqual([]);
    expect(unclosed.content).toContain("get_weather");
});
