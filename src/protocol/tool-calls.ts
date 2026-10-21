import { createHash } from "node:crypto";

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}

export type ToolChoice =
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };

export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

const OPEN_MARKER = "<tool_calls>";
const CLOSE_MARKER = "</tool_calls>";
const MAX_CALLS = 8;

// 只有带 tools 的请求才注入这段协议；放在 prompt 顶部
export function buildToolProtocol(
    tools: readonly ToolDefinition[],
    choice: ToolChoice,
    parallelToolCalls: boolean
): string {
    if(tools.length === 0) {
        return "";
    }

    const definitions = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description ?? "",
        parameters: tool.function.parameters ?? { type: "object", properties: {} }
    }));

    const lines = [
        "## 工具调用",
        "<tools>",
        JSON.stringify(definitions),
        "</tools>",
        "调用工具时，先写简短说明，再在回复末尾输出：",
        OPEN_MARKER,
        '[{"name":"工具名","arguments":{"参数名":"参数值"}}]',
        CLOSE_MARKER,
        `要求：arguments 为 JSON 对象，块内为合法 JSON 数组，块后不得再有内容；只能用上述工具；不需要工具时正常回答。`
    ];
    if(!parallelToolCalls) {
        lines.push("一次最多调用一个工具。");
    }
    const directive = toolChoiceDirective(choice, parallelToolCalls);
    if(directive.length > 0) {
        lines.push(directive);
    }
    return lines.join("\n");
}

// 复用会话时，把本轮 tool_choice 要求附加到增量 prompt 末尾
export function toolChoiceDirective(choice: ToolChoice, parallelToolCalls = true): string {
    if(choice === "none") {
        return "本轮禁止调用任何工具，请直接回答。";
    }
    if(choice === "required") {
        return parallelToolCalls
            ? "本轮必须调用至少一个工具。"
            : "本轮必须调用恰好一个工具。";
    }
    if(typeof choice === "object") {
        return `本轮必须调用工具 "${choice.function.name}"。`;
    }
    return "";
}

export function hashTools(tools: readonly ToolDefinition[]): string {
    if(tools.length === 0) {
        return "";
    }
    const normalized = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description ?? "",
        parameters: tool.function.parameters ?? {},
        strict: tool.function.strict ?? false
    })).sort((a, b) => a.name.localeCompare(b.name));
    return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

function stableStringify(value: unknown): string {
    if(value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if(Array.isArray(value)) {
        return "[" + value.map(stableStringify).join(",") + "]";
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return "{" + keys.map((key) =>
        `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",") + "}";
}

function isRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newCallId(): string {
    return "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function parseToolCallBlock(raw: string, names: ReadonlySet<string>): ToolCall[] | null {
    let text = raw.trim();
    if(text.length === 0) {
        return null;
    }

    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if(fenced !== null) {
        text = fenced[1]!.trim();
    }

    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }

    const items = Array.isArray(value) ? value
        : (isRecord(value) && Array.isArray(value.tool_calls) ? value.tool_calls : null);
    if(items === null || items.length === 0 || items.length > MAX_CALLS) {
        return null;
    }

    const calls: ToolCall[] = [];
    for(const item of items) {
        if(!isRecord(item)) {
            return null;
        }
        const fn = isRecord(item.function) ? item.function : item;
        const name = fn.name;
        if(typeof name !== "string" || !names.has(name)) {
            return null;
        }
        let args: unknown = fn.arguments;
        if(typeof args === "string") {
            try {
                args = JSON.parse(args);
            } catch {
                return null;
            }
        }
        if(!isRecord(args)) {
            return null;
        }
        calls.push({
            id: newCallId(),
            name,
            arguments: JSON.stringify(args)
        });
    }
    return calls;
}

// 最长“可能是 OPEN_MARKER 前缀”的后缀长度，先扣住不发给客户端
function partialMarkerSuffix(text: string, marker: string): number {
    const max = Math.min(text.length, marker.length - 1);
    for(let length = max; length > 0; length--) {
        if(text.endsWith(marker.slice(0, length))) {
            return length;
        }
    }
    return 0;
}

// 流式扫描器：过滤 <tool_calls> 块，解析成功后从 done 事件带出
export class ToolCallScanner {
    private readonly names: ReadonlySet<string>;
    private pending = "";
    private block: string | null = null;
    private closed = false;
    private calls: ToolCall[] = [];

    constructor(names: Iterable<string>) {
        this.names = new Set(names);
    }

    // 返回可以安全作为 content 发出去的文本
    push(text: string): string {
        if(text.length === 0) {
            return "";
        }
        this.pending += text;
        let output = "";

        while(this.pending.length > 0) {
            if(this.closed) {
                output += this.pending;
                this.pending = "";
                break;
            }

            if(this.block === null) {
                const openAt = this.pending.indexOf(OPEN_MARKER);
                if(openAt === -1) {
                    const keep = partialMarkerSuffix(this.pending, OPEN_MARKER);
                    const emitLength = this.pending.length - keep;
                    output += this.pending.slice(0, emitLength);
                    this.pending = this.pending.slice(emitLength);
                    break;
                }
                output += this.pending.slice(0, openAt);
                this.pending = this.pending.slice(openAt + OPEN_MARKER.length);
                this.block = "";
                continue;
            }

            const closeAt = this.pending.indexOf(CLOSE_MARKER);
            if(closeAt === -1) {
                // 闭合标记也可能被 chunk 切开：只扣住可能是其前缀的尾巴
                const keep = partialMarkerSuffix(this.pending, CLOSE_MARKER);
                const appendLength = this.pending.length - keep;
                this.block += this.pending.slice(0, appendLength);
                this.pending = this.pending.slice(appendLength);
                break;
            }

            this.block += this.pending.slice(0, closeAt);
            this.pending = this.pending.slice(closeAt + CLOSE_MARKER.length);

            const parsed = parseToolCallBlock(this.block, this.names);
            if(parsed === null) {
                // 格式不合法：原样当文本返回，避免静默丢内容
                output += OPEN_MARKER + this.block + CLOSE_MARKER;
                this.calls = [];
            } else {
                this.calls = parsed;
            }
            this.block = null;
            this.closed = true;
        }

        return output;
    }

    finish(): { content: string; toolCalls: ToolCall[] } {
        let output = "";
        if(this.block !== null) {
            // 块没有闭合：保留原文
            output += OPEN_MARKER + this.block;
            this.block = null;
            this.closed = true;
        } else if(!this.closed) {
            output += this.pending;
            this.pending = "";
        }
        if(this.pending.length > 0) {
            output += this.pending;
            this.pending = "";
        }
        return { content: output, toolCalls: this.calls };
    }
}
