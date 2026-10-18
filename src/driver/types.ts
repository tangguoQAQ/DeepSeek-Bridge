import type { CompletionOutcome } from "../protocol/patch-stream";

export interface ChatOptions {
    prompt: string;
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
