import type { CompletionOutcome } from "../protocol/patch-stream";

export interface ChatOptions {
    prompt: string;
    thinking?: boolean;
    search?: boolean;
}

// §5.6 驱动层接口（M2 最小版：非流式；M3 扩展为增量事件）
export interface ChatBackend {
    chat(opts: ChatOptions): Promise<CompletionOutcome>;
}
