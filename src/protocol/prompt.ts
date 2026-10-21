import type { ToolCall, ToolChoice, ToolDefinition } from "./tool-calls";
import { buildToolProtocol } from "./tool-calls";

export interface PromptMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
}

export interface BuildPromptResult {
    prompt: string;
    truncated: boolean;
}

export interface ToolingOptions {
    tools: ToolDefinition[];
    toolChoice: ToolChoice;
    parallelToolCalls: boolean;
}

const HEADER = `以下是对话记录。请直接回答最后一条 [User] 消息，不要输出 [Assistant] 前缀。`;

// TODO: 把历史消息提交为文件
const ELLIPSIS = "……（截断部分）……";
const PREFILL_NOTE = "（请继续完成上一条助手消息）";

function renderToolCallHistory(call: ToolCall): { id: string; name: string; arguments: unknown } {
    let args: unknown = call.arguments;
    try {
        args = JSON.parse(call.arguments);
    } catch {
        // 保留字符串
    }
    return { id: call.id, name: call.name, arguments: args };
}

export function renderMessage(msg: PromptMessage): string {
    if(msg.role === "tool") {
        const id = msg.toolCallId ? ` id=${msg.toolCallId}` : "";
        return `[Tool result${id}] ${msg.content}\n\n`;
    }

    const label = msg.role === "user" ? "User"
        : msg.role === "assistant" ? "Assistant" : "System";
    let text = `[${label}] ${msg.content}`;
    if(msg.role === "assistant" && msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
        text += `\n<tool_calls>\n${JSON.stringify(msg.toolCalls.map(renderToolCallHistory))}\n</tool_calls>`;
    }
    return text + "\n\n";
}

// 用于会话复用：只渲染本轮新增的消息（user / tool / assistant prefill）
export function renderIncremental(messages: readonly PromptMessage[]): string {
    return messages.map(renderMessage).join("").trim();
}

export function messageChars(msg: PromptMessage): number {
    return renderMessage(msg).length;
}

function truncateMessage(msg: PromptMessage, limit: number): PromptMessage {
    if(renderMessage(msg).length <= limit) {
        return msg;
    }
    const keep = Math.max(0, limit - ELLIPSIS.length - 32);
    return {
        role: msg.role,
        content: msg.content.slice(0, keep) + ELLIPSIS,
        toolCallId: msg.toolCallId
    };
}

export function buildPrompt(
    messages: PromptMessage[],
    charBudget = 128000,
    tooling?: ToolingOptions
): BuildPromptResult {
    const systems: string[] = [];
    const turns: PromptMessage[] = [];
    for(const msg of messages) {
        if(msg.role === "system") {
            systems.push(msg.content);
        } else {
            turns.push(msg);
        }
    }

    if(turns.length > 0 &&
        turns[turns.length - 1]!.role === "assistant") {
        turns.push({ role: "user", content: PREFILL_NOTE });
    }

    const singleBudget = Math.floor(charBudget / 3);
    for(let i = 0; i < turns.length; i++) {
        const msg = turns[i]!;
        const next = truncateMessage(msg, singleBudget);
        if(next !== msg) {
            turns[i] = next;
            console.warn(`[prompt] ${i + 1}th message truncated`);
        }
    }

    const toolProtocol = tooling === undefined
        ? ""
        : buildToolProtocol(tooling.tools, tooling.toolChoice, tooling.parallelToolCalls);

    const head = `${HEADER}\n\n`
        + (toolProtocol.length > 0 ? `${toolProtocol}\n\n` : "")
        + (systems.length > 0 ? `[System] ${systems.join("\n")}\n\n` : "");
    let body = turns.map(renderMessage).join("");

    let truncated = false;
    if(head.length + body.length > charBudget) {
        truncated = true;

        const first = turns.slice(0, 2);
        const tail: PromptMessage[] = [];
        let size = head.length + ELLIPSIS.length + 2
            + first.map(renderMessage).join("").length;
        for(let i = turns.length - 1; i >= 2; i--) {
            const piece = renderMessage(turns[i]!);
            if(size + piece.length > charBudget) {
                break;
            }
            tail.unshift(turns[i]!);
            size += piece.length;
        }

        body = first.map(renderMessage).join("") + ELLIPSIS + "\n\n" + tail.map(renderMessage).join("");
        console.warn(`[prompt] History exceeds budget ${charBudget}. Truncated.`);
    }

    return { prompt: head + body, truncated };
}
