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

function buildHead(toolProtocol: string, systemText: string): string {
    return `${HEADER}\n\n`
        + (toolProtocol.length > 0 ? `${toolProtocol}\n\n` : "")
        + (systemText.length > 0 ? `[System] ${systemText}\n\n` : "");
}

// 裁剪时优先保留最近的 user / assistant / tool 上下文，尤其是刚拿到的工具结果
function findMandatoryStart(turns: readonly PromptMessage[]): number {
    if(turns.length === 0) {
        return 0;
    }

    let start = turns.length - 1;
    if(turns[start]!.role === "tool") {
        while(start > 0 && turns[start - 1]!.role === "tool") {
            start--;
        }
        if(start > 0 && turns[start - 1]!.role === "assistant") {
            start--;
        }
    } else if(turns[start]!.role === "user"
        && start > 0
        && turns[start - 1]!.role === "assistant") {
        start--;
    }

    // 把触发工具调用/回答的用户问题一起带上
    if(start > 0
        && turns[start]!.role === "assistant"
        && turns[start - 1]!.role === "user") {
        start--;
    }

    // 如果最近上下文前面紧挨着工具结果，连同调用一起保留
    if(start > 0 && turns[start - 1]!.role === "tool") {
        start--;
        while(start > 0 && turns[start - 1]!.role === "tool") {
            start--;
        }
        if(start > 0 && turns[start - 1]!.role === "assistant") {
            start--;
        }
        if(start > 0
            && turns[start]!.role === "assistant"
            && turns[start - 1]!.role === "user") {
            start--;
        }
    }

    return start;
}

function truncateMessage(msg: PromptMessage, limit: number): PromptMessage {
    if(renderMessage(msg).length <= limit) {
        return msg;
    }

    const emptyLength = renderMessage({
        role: msg.role,
        content: "",
        toolCalls: msg.toolCalls,
        toolCallId: msg.toolCallId
    }).length;
    const contentLimit = limit - emptyLength - ELLIPSIS.length;
    if(contentLimit <= 0 || msg.content.length <= contentLimit) {
        return msg;
    }

    // 保留开头和结尾：当前问题/工具结果的关键内容通常在末尾
    const keepTail = contentLimit <= 1
        ? contentLimit
        : Math.max(1, Math.floor(contentLimit * 0.25));
    const keepHead = contentLimit - keepTail;
    return {
        role: msg.role,
        content: msg.content.slice(0, keepHead)
            + ELLIPSIS
            + (keepTail > 0 ? msg.content.slice(-keepTail) : ""),
        toolCalls: msg.toolCalls,
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

    let systemText = systems.join("\n");
    let head = buildHead(toolProtocol, systemText);
    const rendered = turns.map(renderMessage);
    const bodyLength = rendered.reduce((total, text) => total + text.length, 0);

    if(head.length + bodyLength <= charBudget) {
        return { prompt: head + rendered.join(""), truncated: false };
    }

    const mandatoryStart = findMandatoryStart(turns);
    const mandatoryLength = rendered
        .slice(mandatoryStart)
        .reduce((total, text) => total + text.length, 0);

    // system 先让位：不能为了压缩上下文而丢掉刚返回的工具结果
    if(head.length + mandatoryLength > charBudget && systemText.length > 0) {
        const excess = head.length + mandatoryLength - charBudget;
        const keep = Math.max(0, systemText.length - excess - ELLIPSIS.length - 16);
        const keepStart = keep <= 1 ? 0 : Math.ceil(keep * 0.75);
        const keepEnd = keep - keepStart;
        systemText = systemText.slice(0, keepStart)
            + ELLIPSIS
            + (keepEnd > 0 ? systemText.slice(-keepEnd) : "");
        head = buildHead(toolProtocol, systemText);
    }

    // 首轮上下文能放则放
    let firstCount = 0;
    if(mandatoryStart > 0) {
        const maxFirst = Math.min(2, mandatoryStart);
        for(let count = 1; count <= maxFirst; count++) {
            const firstLength = rendered
                .slice(0, count)
                .reduce((total, text) => total + text.length, 0);
            if(head.length + firstLength + mandatoryLength > charBudget) {
                break;
            }
            firstCount = count;
        }
    }

    // 剩余预算从新到旧填充
    const firstLength = rendered
        .slice(0, firstCount)
        .reduce((total, text) => total + text.length, 0);
    const optional: number[] = [];
    let size = head.length + firstLength + mandatoryLength;
    for(let i = mandatoryStart - 1; i >= firstCount; i--) {
        const pieceLength = rendered[i]!.length;
        if(size + pieceLength > charBudget) {
            break;
        }
        optional.unshift(i);
        size += pieceLength;
    }

    const followingStart = optional[0] ?? mandatoryStart;
    const bodyParts: string[] = [];
    for(let i = 0; i < firstCount; i++) {
        bodyParts.push(rendered[i]!);
    }
    if(followingStart > firstCount) {
        bodyParts.push(ELLIPSIS + "\n\n");
    }
    for(const i of optional) {
        bodyParts.push(rendered[i]!);
    }
    for(let i = mandatoryStart; i < turns.length; i++) {
        bodyParts.push(rendered[i]!);
    }

    const prompt = head + bodyParts.join("");
    if(prompt.length > charBudget) {
        console.warn(`[prompt] History still exceeds budget ${charBudget} after reserving latest turns (${prompt.length})`);
    } else {
        console.warn(`[prompt] History exceeds budget ${charBudget}. Truncated.`);
    }
    return { prompt, truncated: true };
}
