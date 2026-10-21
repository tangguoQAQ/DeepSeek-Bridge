import type { CompletionOutcome } from "../protocol/patch-stream";
import type { PromptMessage } from "../protocol/prompt";
import type { ToolCall } from "../protocol/tool-calls";

export interface ChatOptions {
    prompt: string;
    // 客户端完整消息（用于会话复用匹配；缺省则每次新建会话）
    messages?: PromptMessage[];
    thinking?: boolean;
    search?: boolean;
    // 工具协议：存在 toolNames 时扫描 <tool_calls>；[] 表示本轮禁止调用
    toolsHash?: string;
    toolNames?: string[];
    // 复用会话时附加的本轮 tool_choice 要求
    toolDirective?: string;
}

export type ChatEvent =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | {
        type: "done";
        outcome: CompletionOutcome;
        toolCalls?: ToolCall[];
        content?: string;
    };

// §5.6 驱动层接口（M3：流式事件；错误用 throw，取消看 signal）
export interface ChatBackend {
    chat(opts: ChatOptions, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
}
