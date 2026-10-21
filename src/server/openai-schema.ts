import { z } from "zod";
import { ApiError } from "./errors";
import type { PromptMessage } from "../protocol/prompt";
import type { ToolCall, ToolChoice, ToolDefinition } from "../protocol/tool-calls";

export interface ChatRequest {
    model: string;
    messages: PromptMessage[];
    stream: boolean;
    includeUsage: boolean;
    stop: string[];
    maxTokens: number | null;
    tools: ToolDefinition[];
    toolChoice: ToolChoice;
    parallelToolCalls: boolean;
}

const contentPartSchema = z.object({
    type: z.string(),
    text: z.string().optional(),
});

const messageSchema = z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(contentPartSchema)]).nullable().optional(),
    tool_calls: z.array(z.unknown()).optional(),
    tool_call_id: z.string().optional(),
});

const requestSchema = z.object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    max_tokens: z.number().int().positive().optional(),
    n: z.number().int().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    functions: z.unknown().optional(),
    response_format: z.unknown().optional(),
    logprobs: z.unknown().optional(),
});

const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

function bad(message: string): ApiError {
    return new ApiError(400, "invalid_request_error", message);
}

function unsupported(name: string): ApiError {
    return new ApiError(400, "invalid_request_error",
        `DeepSeekBridge does not support ${name}`);
}

function isRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageText(msg: { content?: string | Array<{ type: string; text?: string }> | null }, path: string): string {
    if(typeof msg.content === "string") {
        return msg.content;
    }
    if(Array.isArray(msg.content)) {
        const pieces: string[] = [];
        for(const part of msg.content) {
            if(part.type !== "text") {
                throw new ApiError(400, "invalid_request_error",
                    `Bad type of message content: ${part.type}`);
            }
            pieces.push(part.text ?? "");
        }
        return pieces.join("\n");
    }
    if(msg.content === null || msg.content === undefined) {
        return "";
    }
    throw bad(`${path}.content must be a string or an array of text parts`);
}

function parseTools(value: unknown): ToolDefinition[] {
    if(value === undefined) {
        return [];
    }
    if(!Array.isArray(value)) {
        throw bad("tools must be an array");
    }

    const seen = new Set<string>();
    const tools: ToolDefinition[] = [];
    for(let i = 0; i < value.length; i++) {
        const item = value[i];
        if(!isRecord(item)) {
            throw bad(`tools.${i} must be an object`);
        }
        if(item.type !== undefined && item.type !== "function") {
            throw bad(`tools.${i}.type must be "function"`);
        }
        const fn = item.function;
        if(!isRecord(fn)) {
            throw bad(`tools.${i}.function is required`);
        }
        if(typeof fn.name !== "string" || !TOOL_NAME.test(fn.name)) {
            throw bad(`tools.${i}.function.name must match ${TOOL_NAME}`);
        }
        if(seen.has(fn.name)) {
            throw bad(`Duplicate tool name: ${fn.name}`);
        }
        seen.add(fn.name);

        if(fn.description !== undefined && typeof fn.description !== "string") {
            throw bad(`tools.${i}.function.description must be a string`);
        }
        if(fn.parameters !== undefined && !isRecord(fn.parameters)) {
            throw bad(`tools.${i}.function.parameters must be an object`);
        }
        if(fn.strict !== undefined && typeof fn.strict !== "boolean") {
            throw bad(`tools.${i}.function.strict must be a boolean`);
        }

        tools.push({
            type: "function",
            function: {
                name: fn.name,
                description: fn.description,
                parameters: fn.parameters,
                strict: fn.strict
            }
        });
    }
    return tools;
}

function parseToolChoice(value: unknown, tools: ToolDefinition[]): ToolChoice {
    if(value === undefined) {
        return "auto";
    }
    if(value === "auto" || value === "none" || value === "required") {
        if(value === "required" && tools.length === 0) {
            throw bad("tool_choice \"required\" requires at least one tool");
        }
        return value;
    }
    if(isRecord(value) && value.type === "function" && isRecord(value.function)
        && typeof value.function.name === "string") {
        const name = value.function.name;
        if(!tools.some((tool) => tool.function.name === name)) {
            throw bad(`tool_choice references unknown tool: ${name}`);
        }
        return { type: "function", function: { name } };
    }
    throw bad("tool_choice must be \"auto\", \"none\", \"required\" or a function object");
}

function parseToolCalls(value: unknown[], path: string): ToolCall[] {
    const calls: ToolCall[] = [];
    for(let i = 0; i < value.length; i++) {
        const item = value[i];
        if(!isRecord(item)) {
            throw bad(`${path}.${i} must be an object`);
        }
        if(item.type !== undefined && item.type !== "function") {
            throw bad(`${path}.${i}.type must be "function"`);
        }
        if(typeof item.id !== "string" || item.id.length === 0) {
            throw bad(`${path}.${i}.id is required`);
        }
        const fn = item.function;
        if(!isRecord(fn) || typeof fn.name !== "string" || fn.name.length === 0) {
            throw bad(`${path}.${i}.function.name is required`);
        }

        let args: unknown = fn.arguments ?? {};
        if(typeof args === "string") {
            try {
                args = JSON.parse(args);
            } catch {
                throw bad(`${path}.${i}.function.arguments must be valid JSON`);
            }
        }
        if(!isRecord(args)) {
            throw bad(`${path}.${i}.function.arguments must be a JSON object`);
        }

        calls.push({
            id: item.id,
            name: fn.name,
            arguments: JSON.stringify(args)
        });
    }
    return calls;
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

    for(const key of ["functions", "response_format", "logprobs"] as const) {
        if(request[key] !== undefined) {
            throw unsupported(key);
        }
    }
    if(request.n !== undefined && request.n > 1) {
        throw unsupported("n > 1");
    }

    const tools = parseTools(request.tools);
    const toolChoice = parseToolChoice(request.tool_choice, tools);
    const messages: PromptMessage[] = [];

    for(let i = 0; i < request.messages.length; i++) {
        const msg = request.messages[i]!;
        const path = `messages.${i}`;

        if(msg.role !== "system"
            && msg.role !== "developer"
            && msg.role !== "user"
            && msg.role !== "assistant"
            && msg.role !== "tool") {
            throw new ApiError(400, "invalid_request_error",
                `DeepSeekBridge does not support role "${msg.role}"`);
        }

        const text = messageText(msg, path);

        if(msg.role === "tool") {
            if(msg.tool_calls !== undefined) {
                throw bad(`${path}.tool_calls is only allowed on assistant messages`);
            }
            if(typeof msg.tool_call_id !== "string" || msg.tool_call_id.length === 0) {
                throw bad(`${path}.tool_call_id is required for tool messages`);
            }
            messages.push({
                role: "tool",
                content: text,
                toolCallId: msg.tool_call_id
            });
            continue;
        }

        if(msg.role === "assistant") {
            const toolCalls = msg.tool_calls === undefined
                ? undefined
                : parseToolCalls(msg.tool_calls, `${path}.tool_calls`);
            messages.push({
                role: "assistant",
                content: text,
                toolCalls: toolCalls !== undefined && toolCalls.length > 0 ? toolCalls : undefined
            });
            continue;
        }

        if(msg.tool_calls !== undefined) {
            throw bad(`${path}.tool_calls is only allowed on assistant messages`);
        }
        messages.push({
            role: msg.role === "developer" ? "system" : msg.role,
            content: text
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
        tools,
        toolChoice,
        parallelToolCalls: request.parallel_tool_calls ?? true
    };
}
