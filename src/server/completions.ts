import { buildPrompt } from "../protocol/prompt";
import { hashTools, toolChoiceDirective } from "../protocol/tool-calls";
import type { ToolCall } from "../protocol/tool-calls";
import { ApiError } from "./errors";
import { deltaChunk, finishChunk, usageChunk, SSE_DONE, SSE_PING, KEEPALIVE_INTERVAL_MS } from "./sse";
import type { ChatRequest } from "./openai-schema";
import type { CompletionOutcome } from "../protocol/patch-stream";
import type { ChatBackend, ChatEvent } from "../driver/types";
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
            content: string | null;
            reasoning_content?: string;
            tool_calls?: Array<{
                id: string;
                type: "function";
                function: {
                    name: string;
                    arguments: string;
                };
            }>;
        };
        finish_reason: "stop" | "tool_calls";
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

// 非流式：消费驱动增量流，汇总成完整响应（M3 起非流式也走流式驱动，§5.6）
export async function runChatCompletion(
    req: ChatRequest,
    queue: SerialQueue,
    backend: ChatBackend,
    promptCharBudget: number,
): Promise<ChatCompletionResponse> {
    const { prompt, model, toolsHash, toolNames, toolDirective } = prepare(req, promptCharBudget);

    const collected = await queue.run(async () => {
        let text = "";
        let reasoning = "";
        let toolCalls: ToolCall[] = [];
        let outcome: CompletionOutcome | null = null;

        for await (const event of backend.chat({
            prompt,
            messages: req.messages,
            thinking: model.thinking,
            search: model.search,
            toolsHash,
            toolNames,
            toolDirective
        })) {
            if(event.type === "text") {
                text += event.text;
            } else if(event.type === "reasoning") {
                reasoning += event.text;
            } else {
                outcome = event.outcome;
                toolCalls = event.toolCalls ?? [];
            }
        }

        if(outcome === null) {
            throw new ApiError(502, "api_error", "Stream ended without completion event");
        }
        if(!outcome.finished) {
            console.warn("[api] Stream closed without FINISHED status; returning partial content");
        }
        return { text, reasoning, outcome, toolCalls };
    });

    return buildCompletionResponse(
        collected.text,
        collected.reasoning,
        collected.toolCalls,
        collected.outcome,
        model,
        prompt
    );
}

// 流式：驱动事件 → OpenAI SSE chunk（首个事件前的错误以普通 HTTP 错误返回，§6.6）
export async function runChatCompletionStream(
    req: ChatRequest,
    queue: SerialQueue,
    backend: ChatBackend,
    promptCharBudget: number,
): Promise<Response> {
    const { prompt, model, toolsHash, toolNames, toolDirective } = prepare(req, promptCharBudget);

    const abort = new AbortController();
    const release = await queue.acquire();
    const iterator = backend.chat({
        prompt,
        messages: req.messages,
        thinking: model.thinking,
        search: model.search,
        toolsHash,
        toolNames,
        toolDirective
    }, abort.signal);

    let first: IteratorResult<ChatEvent>;
    try {
        first = await iterator.next();
    } catch(err) {
        release();
        throw err;
    }
    if(first.done) {
        release();
        throw new ApiError(502, "api_error", "Stream ended before producing any event");
    }

    const id = `chatcmpl-ds-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const promptTokens = estimateTokens(prompt);

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            void (async () => {
                let lastSendAt = Date.now();
                let controllerClosed = false;

                const send = (text: string) => {
                    if(controllerClosed) {
                        return;
                    }
                    lastSendAt = Date.now();
                    try {
                        controller.enqueue(encoder.encode(text));
                    } catch {
                        controllerClosed = true;
                    }
                };

                const keepalive = setInterval(() => {
                    if(Date.now() - lastSendAt >= KEEPALIVE_INTERVAL_MS) {
                        send(SSE_PING);
                    }
                }, KEEPALIVE_INTERVAL_MS);

                let roleSent = false;
                const ensureRole = () => {
                    if(!roleSent) {
                        roleSent = true;
                        send(deltaChunk(id, created, model.id, { role: "assistant" }));
                    }
                };

                let outcome: CompletionOutcome | null = null;
                let toolCalls: ToolCall[] = [];
                let current: IteratorResult<ChatEvent> = first;

                try {
                    while(!current.done) {
                        const event = current.value;
                        if(event.type === "text") {
                            ensureRole();
                            send(deltaChunk(id, created, model.id, { content: event.text }));
                        } else if(event.type === "reasoning") {
                            ensureRole();
                            send(deltaChunk(id, created, model.id, { reasoning_content: event.text }));
                        } else {
                            outcome = event.outcome;
                            toolCalls = event.toolCalls ?? [];
                            break;
                        }
                        current = await iterator.next();
                    }

                    ensureRole();
                    if(outcome !== null && !outcome.finished) {
                        console.warn("[sse] Stream closed without FINISHED status; finishing anyway");
                    }
                    let finishReason: "stop" | "tool_calls" = "stop";
                    if(toolCalls.length > 0) {
                        finishReason = "tool_calls";
                        send(deltaChunk(id, created, model.id, {
                            tool_calls: toolCalls.map((call, index) => ({
                                index,
                                id: call.id,
                                type: "function",
                                function: {
                                    name: call.name,
                                    arguments: call.arguments
                                }
                            }))
                        }));
                    }
                    send(finishChunk(id, created, model.id, finishReason));
                    if(req.includeUsage) {
                        const completionTokens = outcome?.completionTokens ?? 0;
                        send(usageChunk(id, created, model.id, {
                            prompt_tokens: promptTokens,
                            completion_tokens: completionTokens,
                            total_tokens: promptTokens + completionTokens
                        }));
                    }
                    send(SSE_DONE);
                } catch(err) {
                    // 首字节后出错：直接断开流（§6.6）
                    console.warn(`[sse] Stream aborted: ${(err as Error).message}`);
                    if(!controllerClosed) {
                        controllerClosed = true;
                        try { controller.error(err); } catch {}
                    }
                } finally {
                    clearInterval(keepalive);
                    try { await iterator.return(undefined); } catch {}
                    release();
                    if(!controllerClosed) {
                        try { controller.close(); } catch {}
                    }
                }
            })();
        },
        cancel() {
            abort.abort();
        }
    });

    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-dsbridge-usage": "estimated"
        }
    });
}

function prepare(
    req: ChatRequest,
    promptCharBudget: number
): {
    prompt: string;
    model: ModelProfile;
    toolsHash: string;
    toolNames: string[] | undefined;
    toolDirective: string;
} {
    const model = resolveModel(req.model);
    // tool_choice=none：本轮不把工具暴露给网页模型，避免“有工具但不许用”导致空回复。
    // toolsHash 置空，与启用工具的会话隔离；后续切回 auto 会自然新建会话。
    const toolsEnabled = req.tools.length > 0 && req.toolChoice !== "none";
    const tooling = toolsEnabled
        ? {
            tools: req.tools,
            toolChoice: req.toolChoice,
            parallelToolCalls: req.parallelToolCalls
        }
        : undefined;
    const { prompt, truncated } = buildPrompt(req.messages, promptCharBudget, tooling);
    if(truncated) {
        console.warn(`[api] Prompt exceeded budget (${promptCharBudget} chars), truncated`);
    }

    return {
        prompt,
        model,
        toolsHash: toolsEnabled ? hashTools(req.tools) : "",
        toolNames: req.tools.length === 0
            ? undefined
            : req.toolChoice === "none"
                ? []
                : req.tools.map((tool) => tool.function.name),
        toolDirective: toolsEnabled
            ? toolChoiceDirective(req.toolChoice, req.parallelToolCalls)
            : ""
    };
}

function buildCompletionResponse(
    text: string,
    reasoning: string,
    toolCalls: ToolCall[],
    outcome: CompletionOutcome,
    model: ModelProfile,
    prompt: string,
): ChatCompletionResponse {
    const message: ChatCompletionResponse["choices"][0]["message"] = {
        role: "assistant",
        content: text
    };
    if(toolCalls.length > 0) {
        message.content = text.length > 0 ? text : null;
        message.tool_calls = toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
                name: call.name,
                arguments: call.arguments
            }
        }));
    }
    if(model.thinking && reasoning.length > 0) {
        message.reasoning_content = reasoning;
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
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
            logprobs: null
        }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: outcome.completionTokens,
            total_tokens: promptTokens + outcome.completionTokens
        }
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
