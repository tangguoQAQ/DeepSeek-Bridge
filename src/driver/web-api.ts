import type { Page } from "patchright";
import { ApiError } from "../server/errors";
import { getUserToken } from "../browser/auth";
import { CompletionStream } from "../protocol/patch-stream";
import { solvePow, buildPowHeader } from "../pow/solve";
import type { PowChallenge } from "../pow/solve";
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

// M3 流式版：页面内 reader 逐块读取 → 页面积压 → take 长轮询拉回 → 进程侧增量事件（§5.2/§5.6）
export class WebApiDriver implements ChatBackend {
    private reqSeq = 0;
    private readonly queues = new Map<number, PushQueue>();

    constructor(private readonly page: Page) {}

    async *chat(opts: ChatOptions, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
        const token = await getUserToken(this.page);
        if(token === null) {
            throw new ApiError(401, "authentication_error",
                "未登录：请在浏览器窗口登录 DeepSeek 后重试");
        }

        const boot: {
            sessionId: string | null;
            challenge: PowChallenge | null;
            sessionStatus: number;
            challengeStatus: number;
        } = await this.page.evaluate(async (tok: string) => {
            const headers = {
                "content-type": "application/json",
                authorization: "Bearer " + tok
            };

            const sessionRes = await fetch("/api/v0/chat_session/create", {
                method: "POST",
                headers,
                body: "{}"
            });
            const sessionJson = await sessionRes.json();
            const sessionId = sessionJson?.data?.biz_data?.id ?? null;

            const challengeRes = await fetch("/api/v0/chat/create_pow_challenge", {
                method: "POST",
                headers,
                body: JSON.stringify({ target_path: "/api/v0/chat/completion" })
            });
            const challengeJson = await challengeRes.json();
            const challenge = challengeJson?.data?.biz_data?.challenge ?? null;

            return {
                sessionId,
                challenge,
                sessionStatus: sessionRes.status,
                challengeStatus: challengeRes.status
            };
        }, token);

        if(boot.sessionId === null || boot.challenge === null) {
            throw new ApiError(502, "api_error",
                `建会话/取挑战失败（session HTTP ${boot.sessionStatus} / challenge HTTP ${boot.challengeStatus}）`);
        }

        const solved = await solvePow(boot.challenge);
        const powHeader = buildPowHeader(boot.challenge, solved.answer);

        const reqId = ++this.reqSeq;
        const queue = new PushQueue();
        this.queues.set(reqId, queue);

        const startedAt = Date.now();
        let lastDataAt = startedAt;
        let firstDeltaAt: number | null = null;
        let httpStatus = 0;
        let contentType: string | null = null;
        let pageError: string | null = null;
        let pageDone = false;

        const pageRun = this.page.evaluate(async (arg: {
            reqId: number;
            token: string;
            sessionId: string;
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
                        parent_message_id: null,
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
            token,
            sessionId: boot.sessionId,
            powHeader,
            prompt: opts.prompt,
            thinking: opts.thinking ?? false,
            search: opts.search ?? false,
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
                    }) as TakeResult;
                    if(take.k === "data") {
                        for(const item of take.items) {
                            queue.push(item);
                        }
                        continue;
                    }
                    if(take.k === "idle") {
                        continue;
                    }
                    if(take.k === "gone" && goneRetries < 3) {
                        // 启动竞态兜底：通道可能还没建好
                        goneRetries++;
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        continue;
                    }
                    break;
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
        if(signal) {
            if(signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        }

        const stream = new CompletionStream();

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
                } else if(msg.k === "chunk" && httpStatus === 200) {
                    lastDataAt = Date.now();
                    for(const delta of stream.push(msg.text ?? "")) {
                        if(firstDeltaAt === null) {
                            firstDeltaAt = Date.now();
                        }
                        yield delta;
                    }
                }
            }

            for(const delta of stream.flush()) {
                if(firstDeltaAt === null) {
                    firstDeltaAt = Date.now();
                }
                yield delta;
            }

            if(signal?.aborted) {
                return;
            }
            if(httpStatus !== 200) {
                if(httpStatus === 401) {
                    throw new ApiError(401, "authentication_error",
                        "登录已失效：请在浏览器窗口重新登录");
                }
                if(httpStatus === 429) {
                    throw new ApiError(429, "rate_limit_error",
                        "DeepSeek 网页端返回 429（可能触发限流）");
                }
                if(httpStatus === 0 && pageError !== null) {
                    throw new ApiError(502, "api_error", `completion 请求失败：${pageError}`);
                }
                throw new ApiError(502, "api_error",
                    `completion 返回 HTTP ${httpStatus}（content-type: ${contentType}）`);
            }
            if(pageError !== null) {
                throw new ApiError(502, "api_error", `读取流失败：${pageError}`);
            }

            yield { type: "done", outcome: stream.outcome() };
        } finally {
            if(signal) {
                signal.removeEventListener("abort", onAbort);
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

    private timeoutReason(startedAt: number, firstDeltaAt: number | null): string {
        const now = Date.now();
        if(now - startedAt >= TOTAL_TIMEOUT_MS) {
            return `总时长超时（${TOTAL_TIMEOUT_MS / 60000} 分钟）`;
        }
        if(firstDeltaAt === null && now - startedAt >= FIRST_TOKEN_TIMEOUT_MS) {
            return `首 token 超时（${FIRST_TOKEN_TIMEOUT_MS / 1000} 秒无增量）`;
        }
        return `增量间隔超时（${IDLE_TIMEOUT_MS / 1000} 秒无数据）`;
    }
}
