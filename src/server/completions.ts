import { parseChatRequest } from "./openai-schema";
import { buildPrompt } from "../protocol/prompt";
import { ApiError } from "./errors";
import type { CompletionOutcome } from "../protocol/patch-stream";
import type { ChatBackend } from "../driver/types";
import type { SerialQueue } from "../queue";

export interface ModelProfile {
    id: string;
    thinking: boolean;
    search: boolean;
}

export interface ChatCompletionResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: "assistant";
            content: string;
            reasoning_content?: string;
        };
        finish_reason: "stop";
        logprobs: null;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

// §6.2 模型映射表：对外模型名 → 网页行为开关
export const MODEL_PROFILES: Record<string, { thinking: boolean; search: boolean }> = {
    "deepseek-chat":            { thinking: false, search: false },
    "deepseek-reasoner":        { thinking: true,  search: false },
    "deepseek-search":          { thinking: false, search: true },
    "deepseek-reasoner-search": { thinking: true,  search: true },
};

export function resolveModel(name: string): ModelProfile {
    const profile = MODEL_PROFILES[name];
    if(profile !== undefined) {
        return { id: name, ...profile };
    }

    console.warn(`[api] Unknown model "${name}", falling back to deepseek-chat (thinking/search off)`);
    return { id: name, thinking: false, search: false };
}

export async function runChatCompletion(
    body: unknown,
    queue: SerialQueue,
    backend: ChatBackend,
    promptCharBudget: number,
): Promise<ChatCompletionResponse> {
    const req = parseChatRequest(body);
    const model = resolveModel(req.model);
    const { prompt, truncated } = buildPrompt(req.messages, promptCharBudget);
    if(truncated) {
        console.warn(`[api] Prompt exceeded budget (${promptCharBudget} chars), truncated`);
    }

    const outcome = await queue.run(() => backend.chat({
        prompt,
        thinking: model.thinking,
        search: model.search,
    }));
    if(!outcome.finished) {
        throw new ApiError(504, "timeout_error", "网页端生成未正常结束（超时或被中断）");
    }

    return buildCompletionResponse(outcome, model, prompt);
}

function buildCompletionResponse(
    outcome: CompletionOutcome,
    model: ModelProfile,
    prompt: string,
): ChatCompletionResponse {
    const message: ChatCompletionResponse["choices"][0]["message"] = {
        role: "assistant",
        content: outcome.text,
    };
    if(model.thinking && outcome.reasoning.length > 0) {
        message.reasoning_content = outcome.reasoning;
    }

    const promptTokens = estimateTokens(prompt);
    return {
        id: `chatcmpl-ds-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [{
            index: 0,
            message,
            finish_reason: "stop",
            logprobs: null,
        }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: outcome.completionTokens,
            total_tokens: promptTokens + outcome.completionTokens,
        },
    };
}

// usage 估算：CJK 每字 ≈ 1 token，其余 ≈ 4 字符 1 token（usageMode=estimate，§6.3）
function estimateTokens(text: string): number {
    let cjk = 0;
    for(const ch of text) {
        if(/[\u3000-\u9fff\uff00-\uffef]/u.test(ch)) {
            cjk++;
        }
    }
    return Math.ceil(cjk + (text.length - cjk) / 4);
}
