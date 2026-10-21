import type { CompletionOutcome } from "../protocol/patch-stream";
import type { PromptMessage } from "../protocol/prompt";

export interface ChatOptions {
    prompt: string;
    // 客户端完整消息（用于会话复用匹配；缺省则每次新建会话）
    messages?: PromptMessage[];
    thinking?: boolean;
    search?: boolean;
}

export type ChatEvent =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "done"; outcome: CompletionOutcome };

// §5.6 驱动层接口（M3：流式事件；错误用 throw，取消看 signal）
export interface ChatBackend {
    chat(opts: ChatOptions, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
}
