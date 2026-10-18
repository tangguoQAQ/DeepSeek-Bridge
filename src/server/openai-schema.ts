import { z } from "zod";
import { ApiError } from "./errors";
import type { PromptMessage } from "../protocol/prompt";

export interface ChatRequest {
    model: string;
    messages: PromptMessage[];
    stream: boolean;
    includeUsage: boolean;
    stop: string[];
    maxTokens: number | null;
}

const contentPartSchema = z.object({
    type: z.string(),
    text: z.string().optional(),
});

const messageSchema = z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(contentPartSchema)]).nullable().optional(),
});

const requestSchema = z.object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    max_tokens: z.number().int().positive().optional(),
    n: z.number().int().optional(),
    tools: z.unknown().optional(),
    tool_choice: z.unknown().optional(),
    functions: z.unknown().optional(),
    response_format: z.unknown().optional(),
    logprobs: z.unknown().optional(),
});

function unsupported(name: string): ApiError {
    return new ApiError(400, "invalid_request_error",
        `DeepSeekBridge does not support ${name}`);
}

export function parseChatRequest(body: unknown): ChatRequest {
    const parsed = requestSchema.safeParse(body);
    if(!parsed.success) {
        const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
            .join("; ");
        throw new ApiError(400, "invalid_request_error", `Bad request: ${detail}`);
    }
    const request = parsed.data;

    for(const key of ["tools", "tool_choice", "functions", "response_format", "logprobs"] as const) {
        if(request[key] !== undefined) {
            throw unsupported(key);
        }
    }
    if(request.n !== undefined && request.n > 1) {
        throw unsupported("n > 1");
    }

    const messages: PromptMessage[] = [];
    for(const msg of request.messages) {
        if(msg.role === "tool" || msg.role === "function") {
            throw new ApiError(400, "invalid_request_error",
                `DeepSeekBridge does not support role "${msg.role}"`);
        }
        if(msg.role !== "system" &&
            msg.role !== "user" &&
            msg.role !== "assistant" &&
            msg.role !== "developer") {
            throw new ApiError(400, "invalid_request_error",
                `DeepSeekBridge does not support role "${msg.role}"`);
        }

        let text = "";
        if(typeof msg.content === "string") {
            text = msg.content;
        } else if(Array.isArray(msg.content)) {
            const pieces: string[] = [];
            for(const part of msg.content) {
                if(part.type !== "text") {
                    throw new ApiError(400, "invalid_request_error",
                        `Bad type of message content: ${part.type}`);
                }
                pieces.push(part.text ?? "");
            }
            text = pieces.join("\n");
        }

        messages.push({
            role: msg.role === "developer" ? "system" : msg.role,
            content: text,
        });
    }

    return {
        model: request.model,
        messages,
        stream: request.stream ?? false,
        includeUsage: request.stream_options?.include_usage ?? false,
        stop: request.stop === undefined ? [] :
            typeof request.stop === "string" ? [request.stop] : request.stop,
        maxTokens: request.max_tokens ?? null,
    };
}
