// OpenAI 流式 chunk 构造（§6.6）：纯字符串编码，便于单测

export interface ChunkDelta {
    role?: "assistant";
    content?: string;
    reasoning_content?: string;
}

export interface UsageNumbers {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export const SSE_DONE = "data: [DONE]\n\n";
export const SSE_PING = ": ping\n\n";
export const KEEPALIVE_INTERVAL_MS = 15000;

function base(id: string, created: number, model: string) {
    return { id, object: "chat.completion.chunk", created, model };
}

export function deltaChunk(id: string, created: number, model: string, delta: ChunkDelta): string {
    return `data: ${JSON.stringify({
        ...base(id, created, model),
        choices: [{ index: 0, delta, finish_reason: null, logprobs: null }]
    })}\n\n`;
}

export function finishChunk(id: string, created: number, model: string, finishReason = "stop"): string {
    return `data: ${JSON.stringify({
        ...base(id, created, model),
        choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }]
    })}\n\n`;
}

export function usageChunk(id: string, created: number, model: string, usage: UsageNumbers): string {
    return `data: ${JSON.stringify({
        ...base(id, created, model),
        choices: [],
        usage
    })}\n\n`;
}
