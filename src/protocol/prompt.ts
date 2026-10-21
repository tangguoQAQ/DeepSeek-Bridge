export interface PromptMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface BuildPromptResult {
    prompt: string;
    truncated: boolean;
}

const HEADER = `以下是对话历史，请扮演 Assistant 直接回答最后一条 [User] 消息；
不要添加任何类似 [Assistant] 的前言。`;

// TODO: 把历史消息提交为文件
const ELLIPSIS = "……（截断部分）……";
const PREFILL_NOTE = "（请继续完成上一条助手消息）";

export function buildPrompt(
    messages: PromptMessage[],
    charBudget = 128000
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
        if(msg.content.length > singleBudget) {
            turns[i] = { ...msg,
                content: msg.content.slice(0, singleBudget) + ELLIPSIS };
            console.warn(`[prompt] ${i + 1}th message truncated`);
        }
    }

    const head = `${HEADER}\n\n` + (systems.length > 0 ?
        `[System] ${systems.join("\n")}\n\n` : "");
    const render = (msg: PromptMessage) =>
        `[${msg.role === "user" ? "User" : "Assistant"}] ${msg.content}\n\n`;
    let body = turns.map(render).join("");

    let truncated = false;
    if(head.length + body.length > charBudget) {
        truncated = true;

        const first = turns.slice(0, 2);
        const tail: PromptMessage[] = [];
        let size = head.length + ELLIPSIS.length + 2
            + first.map(render).join("").length;
        for(let i = turns.length - 1; i >= 2; i--) {
            const piece = render(turns[i]!);
            if(size + piece.length > charBudget) {
                break;
            }
            tail.unshift(turns[i]!);
            size += piece.length;
        }

        body = first.map(render).join("") + ELLIPSIS + "\n\n" + tail.map(render).join("");
        console.warn(`[prompt] History exceeds budget ${charBudget}. Truncated.`);
    }

    return { prompt: head + body, truncated };
}
