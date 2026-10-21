import type { Page } from "patchright";
import { ApiError } from "../server/errors";
import { getUserToken } from "../browser/auth";
import { CompletionStream } from "../protocol/patch-stream";
import type { CompletionOutcome } from "../protocol/patch-stream";
import type { PromptMessage } from "../protocol/prompt";
import { messageChars, renderIncremental } from "../protocol/prompt";
import { ToolCallScanner } from "../protocol/tool-calls";
import type { ToolCall } from "../protocol/tool-calls";
import { solvePow, buildPowHeader } from "../pow/solve";
import type { PowChallenge } from "../pow/solve";
import { SessionStore, hashChain, hashMessages, hashUserMessages } from "./session-store";
import type { SessionRecord } from "./session-store";
import type { ChatBackend, ChatEvent, ChatOptions } from "./types";

const FIRST_TOKEN_TIMEOUT_MS = 60000;
const IDLE_TIMEOUT_MS = 60000;
const TOTAL_TIMEOUT_MS = 600000;
const TAKE_WAIT_MS = 5000;

class StreamTimeoutError extends Error {
    constructor() {
        super("Timed out waiting for stream data");
        this.name = "StreamTimeoutError";
    }
}

// 会话在网页端被删除：completion 返回 HTTP 200 + biz_code=1
class SessionInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SessionInvalidError";
    }
}

// 进程 → 页面 → 进程 的每请求推送队列（进程侧缓冲）
class PushQueue {
    private readonly items: string[] = [];
    private waiter: (() => void) | null = null;
    private ended = false;

    push(item: string): void {
        this.items.push(item);
        const wake = this.waiter;
        this.waiter = null;
        wake?.();
    }

    end(): void {
        this.ended = true;
        const wake = this.waiter;
        this.waiter = null;
        wake?.();
    }

    // 等待数据直到 deadline（毫秒时间戳）；超时抛 StreamTimeoutError；流结束返回 null
    async next(deadline: number): Promise<string | null> {
        while(this.items.length === 0) {
            if(this.ended) {
                return null;
            }
            const remain = deadline - Date.now();
            if(remain <= 0) {
                throw new StreamTimeoutError();
            }
            await new Promise<void>((resolve) => {
                let timer: ReturnType<typeof setTimeout> | null = null;
                const wake = () => {
                    if(timer !== null) {
                        clearTimeout(timer);
                    }
                    if(this.waiter === wake) {
                        this.waiter = null;
                    }
                    resolve();
                };
                timer = setTimeout(wake, remain);
                this.waiter = wake;
            });
        }
        return this.items.shift()!;
    }
}

type TakeResult =
    | { k: "data"; items: string[] }
    | { k: "idle" }
    | { k: "end" }
    | { k: "gone" };

// 页面 ← 进程 的长轮询“取件”：取走该请求的缓冲；waitMs 内无数据返回 idle。
// 注：patchright 下 exposeFunction 与 console 事件都不过 CDP，页面 → 进程只能靠拉取。
async function takeChannel(arg: { reqId: number; waitMs: number }): Promise<TakeResult> {
    const w = window as unknown as Record<string, any>;
    const channels = w.__dsbridge_channels as Record<string, {
        items: string[];
        ended: boolean;
        taker: (() => void) | null;
    }> | undefined;
    const channel = channels?.[arg.reqId];
    if(channel === undefined) {
        return { k: "gone" };
    }
    if(channel.items.length > 0) {
        return { k: "data", items: channel.items.splice(0) };
    }
    if(channel.ended) {
        return { k: "end" };
    }

    return await new Promise<TakeResult>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const wake = () => {
            if(timer !== null) {
                clearTimeout(timer);
            }
            if(channel.taker === wake) {
                channel.taker = null;
            }
            if(channel.items.length > 0) {
                resolve({ k: "data", items: channel.items.splice(0) });
            } else if(channel.ended) {
                resolve({ k: "end" });
            } else {
                resolve({ k: "idle" });
            }
        };
        timer = setTimeout(() => {
            if(channel.taker === wake) {
                channel.taker = null;
            }
            resolve({ k: "idle" });
        }, arg.waitMs);
        channel.taker = wake;
    });
}

// runCompletion 内部事件：meta 用于判断 HTTP 状态（会话失效时回退），不对外暴露
type RunEvent =
    | { k: "meta"; status: number; contentType: string | null }
    | ChatEvent;

interface CompletionRun {
    token: string;
    sessionId: string;
    parentMessageId: number | null;
    prompt: string;
    thinking: boolean;
    search: boolean;
    powHeader: string;
    toolNames?: string[];
    signal?: AbortSignal;
}

// M3 流式版：页面内 reader 逐块读取 → 页面积压 → take 长轮询拉回 → 进程侧增量事件（§5.2/§5.6）
export class WebApiDriver implements ChatBackend {
    private reqSeq = 0;
    private readonly queues = new Map<number, PushQueue>();

    constructor(
        private readonly page: Page,
        private readonly store: SessionStore | null = null
    ) {}

    async *chat(opts: ChatOptions, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
        const token = await getUserToken(this.page);
        if(token === null) {
            throw new ApiError(401, "authentication_error",
                "Not signed in. Please sign in to DeepSeek in the browser window and retry.");
        }

        const messages = opts.messages ?? null;
        const toolsHash = opts.toolsHash ?? "";
        let reused: SessionRecord | null = null;
        let newMessages: PromptMessage[] = [];

        // 会话匹配：客户端历史里最长的、与索引记录一致的前缀；剩余部分作为本轮增量
        if(messages !== null && this.store !== null) {
            const match = this.store.match(messages, toolsHash);
            if(match !== null) {
                const extraChars = match.newMessages.reduce(
                    (sum, message) => sum + messageChars(message), 0);
                const toolContinuation = match.viaTool
                    || match.newMessages.some((message) => message.role === "tool");
                if(this.store.charBudget > 0
                    && match.record.chars + extraChars > this.store.charBudget
                    && !toolContinuation) {
                    // 普通对话超预算：放弃复用并清掉旧会话；
                    // 工具结果必须留在原会话里，否则完整 prompt 会被裁剪。
                    this.dropSession(token, match.record);
                } else {
                    reused = match.record;
                    newMessages = match.newMessages;
                    if(toolContinuation) {
                        console.log("[session] Reusing session for tool result");
                    }
                }
            }
        }

        let sessionId: string;
        let parentMessageId: number | null = null;
        let prompt = opts.prompt;
        if(reused !== null) {
            sessionId = reused.id;
            parentMessageId = reused.parentMessageId;
            prompt = renderIncremental(newMessages);
            if(opts.toolDirective !== undefined && opts.toolDirective.length > 0) {
                prompt += `\n\n${opts.toolDirective}`;
            }
        } else {
            sessionId = await this.createSession(token);
            if(messages?.some((message) => message.role === "tool")) {
                console.warn("[session] Tool result could not be matched; created a new session");
            }
        }

        let powHeader = await this.preparePow(token);

        // 复用会话可能已被网页端删除：HTTP 400/404 或 HTTP 200 + biz_code=1 时自动新建会话重试
        while(true) {
            const events = this.runCompletion({
                token,
                sessionId,
                parentMessageId,
                prompt,
                thinking: opts.thinking ?? false,
                search: opts.search ?? false,
                powHeader,
                toolNames: opts.toolNames,
                signal
            });

            try {
                const head = await events.next();
                if(head.done) {
                    return;
                }

                const first = head.value;
                if(reused !== null && "k" in first && first.k === "meta"
                    && (first.status === 400 || first.status === 404)) {
                    await events.return(undefined);
                    this.dropSession(token, reused);
                    reused = null;
                    sessionId = await this.createSession(token);
                    parentMessageId = null;
                    prompt = opts.prompt;
                    powHeader = await this.preparePow(token);
                    continue;
                }

                if(!("k" in first)) {
                    if(first.type === "done") {
                        this.remember(token, opts, messages, reused, sessionId,
                            first.outcome, first.content ?? first.outcome.text, first.toolCalls ?? [],
                            reused !== null ? newMessages : null);
                    }
                    yield first;
                }
                for await (const event of events) {
                    if("k" in event) {
                        continue;
                    }
                    if(event.type === "done") {
                        // 必须在 yield 之前落盘：SSE 路由收到 done 后会直接 return 生成器
                        this.remember(token, opts, messages, reused, sessionId,
                            event.outcome, event.content ?? event.outcome.text, event.toolCalls ?? [],
                            reused !== null ? newMessages : null);
                    }
                    yield event;
                }
                break;
            } catch(err) {
                if(reused !== null && err instanceof SessionInvalidError) {
                    this.dropSession(token, reused);
                    reused = null;
                    sessionId = await this.createSession(token);
                    parentMessageId = null;
                    prompt = opts.prompt;
                    powHeader = await this.preparePow(token);
                    continue;
                }
                throw err;
            }
        }
    }

    private dropSession(token: string, record: SessionRecord): void {
        this.store?.remove(record.id);
        void this.deleteSessions(token, [record.id]);
    }

    // 成功完成后写入会话索引；部分完成或复用失败则丢弃记录
    private remember(
        token: string,
        opts: ChatOptions,
        messages: PromptMessage[] | null,
        reused: SessionRecord | null,
        sessionId: string,
        outcome: CompletionOutcome | null,
        assistantContent: string,
        toolCalls: ToolCall[],
        reusedMessages: PromptMessage[] | null
    ): void {
        if(this.store === null || messages === null) {
            return;
        }
        const last = messages[messages.length - 1];
        const usable = outcome !== null
            && outcome.finished
            && outcome.responseMessageId !== null
            && last !== undefined
            && (last.role === "user" || last.role === "tool")
            && (assistantContent.length > 0 || toolCalls.length > 0);

        if(!usable) {
            if(reused !== null) {
                this.store.remove(reused.id);
            }
            return;
        }

        const assistant: PromptMessage = {
            role: "assistant",
            content: assistantContent
        };
        if(toolCalls.length > 0) {
            assistant.toolCalls = toolCalls;
        }
        const assistantChars = messageChars(assistant);

        // 用当前客户端历史重新生成链 hash，确保 system 等变化后下一轮仍能精确命中
        const chainHash = hashChain(hashMessages(messages), assistant);
        const incremental = reused !== null
            ? (reusedMessages ?? messages.slice(reused.messageCount))
            : [];
        const chars = reused !== null
            ? reused.chars
                + incremental.reduce((sum, message) => sum + messageChars(message), 0)
                + assistantChars
            : opts.prompt.length + assistantChars;

        const evicted = this.store.record({
            id: sessionId,
            chainHash,
            messageCount: messages.length + 1,
            parentMessageId: outcome.responseMessageId!,
            chars,
            toolsHash: reused?.toolsHash ?? opts.toolsHash ?? "",
            toolCallIds: toolCalls.map((call) => call.id),
            userHash: hashUserMessages(messages)
        });

        if(reused === null) {
            void this.tagSession(token, sessionId);
        }
        if(evicted.length > 0) {
            console.log(`[session] Evicted ${evicted.length} old session(s) over limit`);
            void this.deleteSessions(token, evicted.map((record) => record.id));
        }
    }

    private async createSession(token: string): Promise<string> {
        const result = await this.page.evaluate(async (tok: string) => {
            const res = await fetch("/api/v0/chat_session/create", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer " + tok
                },
                body: "{}"
            });
            return { status: res.status, text: await res.text() };
        }, token);

        let sessionId: string | null = null;
        try {
            const json = JSON.parse(result.text) as Record<string, any>;
            const biz = json?.data?.biz_data;
            // 2026-10 起 id 位于 biz_data.chat_session.id，兼容旧版 biz_data.id
            sessionId = biz?.chat_session?.id ?? biz?.id ?? null;
        } catch {
            // fall through
        }
        if(typeof sessionId !== "string" || sessionId.length === 0) {
            throw new ApiError(502, "api_error",
                `Failed to create chat session (HTTP ${result.status})`);
        }
        return sessionId;
    }

    private async preparePow(token: string): Promise<string> {
        const result = await this.page.evaluate(async (tok: string) => {
            const res = await fetch("/api/v0/chat/create_pow_challenge", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer " + tok
                },
                body: JSON.stringify({ target_path: "/api/v0/chat/completion" })
            });
            return { status: res.status, text: await res.text() };
        }, token);

        let challenge: PowChallenge | null = null;
        try {
            const json = JSON.parse(result.text) as Record<string, any>;
            challenge = json?.data?.biz_data?.challenge ?? null;
        } catch {
            // fall through
        }
        if(challenge === null) {
            throw new ApiError(502, "api_error",
                `Failed to fetch PoW challenge (HTTP ${result.status})`);
        }

        const solved = await solvePow(challenge);
        return buildPowHeader(challenge, solved.answer);
    }

    private async *runCompletion(run: CompletionRun): AsyncGenerator<RunEvent> {
        const reqId = ++this.reqSeq;
        const queue = new PushQueue();
        this.queues.set(reqId, queue);

        const startedAt = Date.now();
        let lastDataAt = startedAt;
        let firstDeltaAt: number | null = null;
        let httpStatus = 0;
        let contentType: string | null = null;
        let bodyText = "";
        let pageError: string | null = null;
        let pageDone = false;

        const pageRun = this.page.evaluate(async (arg: {
            reqId: number;
            token: string;
            sessionId: string;
            parentMessageId: number | null;
            powHeader: string;
            prompt: string;
            thinking: boolean;
            search: boolean;
            totalTimeoutMs: number;
        }) => {
            const w = window as unknown as Record<string, any>;
            const controller = new AbortController();
            w.__dsbridgeControllers = w.__dsbridgeControllers ?? {};
            w.__dsbridgeControllers[arg.reqId] = controller;

            w.__dsbridge_channels = w.__dsbridge_channels ?? {};
            const channel = w.__dsbridge_channels[arg.reqId] = {
                items: [] as string[],
                ended: false,
                taker: null as null | (() => void)
            };

            const push = (obj: Record<string, unknown>) => {
                channel.items.push(JSON.stringify({ reqId: arg.reqId, ...obj }));
                const taker = channel.taker;
                channel.taker = null;
                taker?.();
            };

            let result: { ok: boolean; reason: string | null };
            try {
                const res = await fetch("/api/v0/chat/completion", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: "Bearer " + arg.token,
                        "x-ds-pow-response": arg.powHeader
                    },
                    body: JSON.stringify({
                        chat_session_id: arg.sessionId,
                        parent_message_id: arg.parentMessageId,
                        model_type: "default",
                        prompt: arg.prompt,
                        ref_file_ids: [],
                        thinking_enabled: arg.thinking,
                        search_enabled: arg.search,
                        action: null,
                        preempt: false
                    }),
                    signal: controller.signal
                });

                push({ k: "meta", status: res.status, contentType: res.headers.get("content-type") });

                if(!res.body) {
                    result = { ok: false, reason: "empty response body" };
                } else {
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    const deadline = Date.now() + arg.totalTimeoutMs;
                    let tail = "";
                    while(Date.now() < deadline) {
                        const { done, value } = await reader.read();
                        if(done) {
                            break;
                        }
                        const text = decoder.decode(value, { stream: true });
                        push({ k: "chunk", text });
                        tail = (tail + text).slice(-128);
                        if(tail.includes("event: close")) {
                            break;
                        }
                    }
                    try { await reader.cancel(); } catch {}
                    result = { ok: true, reason: null };
                }
            } catch(err) {
                result = { ok: false, reason: String((err as Error)?.message ?? err) };
            }

            channel.ended = true;
            const taker = channel.taker;
            channel.taker = null;
            taker?.();

            delete w.__dsbridgeControllers[arg.reqId];
            return result;
        }, {
            reqId,
            token: run.token,
            sessionId: run.sessionId,
            parentMessageId: run.parentMessageId,
            powHeader: run.powHeader,
            prompt: run.prompt,
            thinking: run.thinking,
            search: run.search,
            totalTimeoutMs: TOTAL_TIMEOUT_MS
        });

        void pageRun.then(
            (res) => {
                if(!res.ok && res.reason !== null && pageError === null) {
                    pageError = res.reason;
                }
            },
            (err) => {
                if(pageError === null) {
                    pageError = err instanceof Error ? err.message : String(err);
                }
            }
        );

        // 泵：持续 take 页面推送灌进 PushQueue；通道结束或页面故障时收尾
        void (async () => {
            let goneRetries = 0;
            try {
                while(true) {
                    const take = await this.page.evaluate(takeChannel, {
                        reqId,
                        waitMs: TAKE_WAIT_MS
                    });
                    if(take.k === "gone") {
                        goneRetries++;
                        if(goneRetries > 2) {
                            break;
                        }
                        continue;
                    }
                    goneRetries = 0;
                    if(take.k === "data") {
                        for(const item of take.items) {
                            queue.push(item);
                        }
                    } else if(take.k === "end") {
                        break;
                    }
                }
            } catch(err) {
                if(pageError === null) {
                    pageError = err instanceof Error ? err.message : String(err);
                }
            }
            pageDone = true;
            queue.end();
        })();

        const abortPage = () => {
            void this.page.evaluate((id: number) => {
                const w = window as unknown as Record<string, any>;
                const controllers = w.__dsbridgeControllers as Record<number, AbortController> | undefined;
                controllers?.[id]?.abort();
            }, reqId).catch(() => {});
        };

        const onAbort = () => {
            abortPage();
            queue.end();
        };
        if(run.signal) {
            if(run.signal.aborted) {
                onAbort();
            } else {
                run.signal.addEventListener("abort", onAbort, { once: true });
            }
        }

        const stream = new CompletionStream();
        const scanner = run.toolNames === undefined
            ? null
            : new ToolCallScanner(run.toolNames);
        let filteredText = "";

        try {
            while(true) {
                const deadline = Math.min(
                    startedAt + TOTAL_TIMEOUT_MS,
                    lastDataAt + IDLE_TIMEOUT_MS,
                    firstDeltaAt === null ? startedAt + FIRST_TOKEN_TIMEOUT_MS : Number.POSITIVE_INFINITY
                );

                let item: string | null;
                try {
                    item = await queue.next(deadline);
                } catch(err) {
                    if(err instanceof StreamTimeoutError) {
                        throw new ApiError(504, "timeout_error", this.timeoutReason(startedAt, firstDeltaAt));
                    }
                    throw err;
                }
                if(item === null) {
                    break;
                }

                const msg = JSON.parse(item) as {
                    k: string;
                    status?: number;
                    contentType?: string | null;
                    text?: string;
                };
                if(msg.k === "meta") {
                    httpStatus = msg.status ?? 0;
                    contentType = msg.contentType ?? null;
                    lastDataAt = Date.now();
                    yield { k: "meta", status: httpStatus, contentType };
                } else if(msg.k === "chunk" && httpStatus === 200) {
                    lastDataAt = Date.now();
                    const text = msg.text ?? "";
                    if(contentType !== null && contentType.includes("application/json")) {
                        if(bodyText.length < 8192) {
                            bodyText += text;
                        }
                    } else {
                        for(const delta of stream.push(text)) {
                            if(firstDeltaAt === null) {
                                firstDeltaAt = Date.now();
                            }
                            if(delta.type === "text" && scanner !== null) {
                                const piece = scanner.push(delta.text);
                                if(piece.length > 0) {
                                    filteredText += piece;
                                    yield { type: "text", text: piece };
                                }
                            } else {
                                yield delta;
                            }
                        }
                    }
                }
            }

            for(const delta of stream.flush()) {
                if(firstDeltaAt === null) {
                    firstDeltaAt = Date.now();
                }
                if(delta.type === "text" && scanner !== null) {
                    const piece = scanner.push(delta.text);
                    if(piece.length > 0) {
                        filteredText += piece;
                        yield { type: "text", text: piece };
                    }
                } else {
                    yield delta;
                }
            }

            let toolCalls: ToolCall[] = [];
            if(scanner !== null) {
                const final = scanner.finish();
                if(final.content.length > 0) {
                    filteredText += final.content;
                    yield { type: "text", text: final.content };
                }
                toolCalls = final.toolCalls;
            }

            if(run.signal?.aborted) {
                return;
            }
            if(httpStatus !== 200) {
                if(httpStatus === 401) {
                    throw new ApiError(401, "authentication_error",
                        "Session expired. Please sign in again in the browser window.");
                }
                if(httpStatus === 429) {
                    throw new ApiError(429, "rate_limit_error",
                        "DeepSeek web returned HTTP 429 (rate limited)");
                }
                if(httpStatus === 0 && pageError !== null) {
                    throw new ApiError(502, "api_error", `Completion request failed: ${pageError}`);
                }
                throw new ApiError(502, "api_error",
                    `Completion returned HTTP ${httpStatus} (content-type: ${contentType})`);
            }
            if(pageError !== null) {
                throw new ApiError(502, "api_error", `Stream read failed: ${pageError}`);
            }

            // 会话失效/业务错误时 DeepSeek 返回 HTTP 200 + JSON（biz_code != 0）
            if(contentType !== null && contentType.includes("application/json") && bodyText.length > 0) {
                let bizCode: number | null = null;
                let bizMsg = "";
                try {
                    const json = JSON.parse(bodyText) as Record<string, any>;
                    bizCode = json?.data?.biz_code ?? null;
                    bizMsg = String(json?.data?.biz_msg ?? "");
                } catch {
                    // ignore
                }
                if(bizCode !== null && bizCode !== 0) {
                    if(bizMsg.toLowerCase().includes("invalid chat session")) {
                        throw new SessionInvalidError(bizMsg);
                    }
                    throw new ApiError(502, "api_error",
                        `Completion rejected by DeepSeek: ${bizMsg || "biz_code " + bizCode}`);
                }
            }

            const outcome = stream.outcome();
            yield {
                type: "done",
                outcome,
                toolCalls,
                content: scanner !== null ? filteredText : outcome.text
            };
        } finally {
            if(run.signal) {
                run.signal.removeEventListener("abort", onAbort);
            }
            if(!pageDone) {
                abortPage();
            }
            this.queues.delete(reqId);
            void this.cleanupChannel(reqId);
        }
    }

    private async cleanupChannel(reqId: number): Promise<void> {
        try {
            await this.page.evaluate((id: number) => {
                const w = window as unknown as Record<string, any>;
                if(w.__dsbridge_channels) {
                    delete w.__dsbridge_channels[id];
                }
            }, reqId);
        } catch {
            // ignore
        }
    }

    private async tagSession(token: string, sessionId: string): Promise<void> {
        const title = "DSB-" + sessionId.replace(/-/g, "").slice(0, 8);
        try {
            const result = await this.page.evaluate(async (arg: { token: string; sessionId: string; title: string }) => {
                const res = await fetch("/api/v0/chat_session/update_title", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: "Bearer " + arg.token
                    },
                    body: JSON.stringify({
                        chat_session_id: arg.sessionId,
                        title: arg.title
                    })
                });
                return { status: res.status, text: await res.text() };
            }, { token, sessionId, title });

            const json = JSON.parse(result.text) as Record<string, any>;
            if(json?.data?.biz_code !== 0) {
                console.warn(`[session] Failed to tag session ${title} (biz_code ${json?.data?.biz_code})`);
            }
        } catch(err) {
            console.warn(`[session] Failed to tag session ${title}: ${(err as Error).message}`);
        }
    }

    private async deleteSessions(token: string, ids: string[]): Promise<void> {
        if(ids.length === 0) {
            return;
        }
        try {
            const result = await this.page.evaluate(async (arg: { token: string; ids: string[] }) => {
                const res = await fetch("/api/v0/chat_session/delete", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: "Bearer " + arg.token
                    },
                    body: JSON.stringify({ chat_session_ids: arg.ids })
                });
                return { status: res.status, text: await res.text() };
            }, { token, ids });

            let bizCode = -1;
            try {
                bizCode = (JSON.parse(result.text) as Record<string, any>)?.data?.biz_code ?? -1;
            } catch {
                // ignore
            }
            if(bizCode !== 0) {
                console.warn(`[session] Failed to delete ${ids.length} session(s) (HTTP ${result.status}, biz_code ${bizCode})`);
            }
        } catch(err) {
            console.warn(`[session] Failed to delete sessions: ${(err as Error).message}`);
        }
    }

    private timeoutReason(startedAt: number, firstDeltaAt: number | null): string {
        const now = Date.now();
        if(now - startedAt >= TOTAL_TIMEOUT_MS) {
            return `Total timeout (${TOTAL_TIMEOUT_MS / 60000} minutes)`;
        }
        if(firstDeltaAt === null && now - startedAt >= FIRST_TOKEN_TIMEOUT_MS) {
            return `First-token timeout (no delta within ${FIRST_TOKEN_TIMEOUT_MS / 1000}s)`;
        }
        return `Idle timeout (no data within ${IDLE_TIMEOUT_MS / 1000}s)`;
    }
}
