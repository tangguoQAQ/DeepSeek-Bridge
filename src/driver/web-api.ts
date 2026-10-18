import type { Page } from "patchright";
import { ApiError } from "../server/errors";
import { getUserToken } from "../browser/auth";
import { reduceSSE } from "../protocol/patch-stream";
import type { CompletionOutcome } from "../protocol/patch-stream";
import { solvePow, buildPowHeader } from "../pow/solve";
import type { PowChallenge } from "../pow/solve";

export interface ChatOptions {
    prompt: string;
    thinking?: boolean;
    search?: boolean;
}

const COMPLETION_TIMEOUT_MS = 120000;

// M2 非流式版：整条 SSE 收完再 reduceSSE；M3 改成增量事件（§5.6 ChatDriver）
export class WebApiDriver {
    constructor(private readonly page: Page) {}

    async chat(opts: ChatOptions): Promise<CompletionOutcome> {
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
                authorization: "Bearer " + tok,
            };

            const sessionRes = await fetch("/api/v0/chat_session/create", {
                method: "POST",
                headers,
                body: "{}",
            });
            const sessionJson = await sessionRes.json();
            const sessionId = sessionJson?.data?.biz_data?.id ?? null;

            const challengeRes = await fetch("/api/v0/chat/create_pow_challenge", {
                method: "POST",
                headers,
                body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
            });
            const challengeJson = await challengeRes.json();
            const challenge = challengeJson?.data?.biz_data?.challenge ?? null;

            return {
                sessionId,
                challenge,
                sessionStatus: sessionRes.status,
                challengeStatus: challengeRes.status,
            };
        }, token);

        if(boot.sessionId === null || boot.challenge === null) {
            throw new ApiError(502, "api_error",
                `建会话/取挑战失败（session HTTP ${boot.sessionStatus} / challenge HTTP ${boot.challengeStatus}）`);
        }

        const solved = await solvePow(boot.challenge);
        const powHeader = buildPowHeader(boot.challenge, solved.answer);

        const result: {
            status: number;
            contentType: string | null;
            text: string;
        } = await this.page.evaluate(async (arg: {
            token: string;
            sessionId: string;
            powHeader: string;
            prompt: string;
            thinking: boolean;
            search: boolean;
            timeoutMs: number;
        }) => {
            const res = await fetch("/api/v0/chat/completion", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer " + arg.token,
                    "x-ds-pow-response": arg.powHeader,
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
                    preempt: false,
                }),
            });

            const status = res.status;
            const contentType = res.headers.get("content-type");
            if(!res.body) {
                return { status, contentType, text: "" };
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let text = "";
            const deadline = Date.now() + arg.timeoutMs;
            while(Date.now() < deadline) {
                const { done, value } = await reader.read();
                if(done) break;
                text += decoder.decode(value, { stream: true });
                if(text.includes("event: close")) break;
            }
            try { await reader.cancel(); } catch {}
            return { status, contentType, text };
        }, {
            token,
            sessionId: boot.sessionId,
            powHeader,
            prompt: opts.prompt,
            thinking: opts.thinking ?? false,
            search: opts.search ?? false,
            timeoutMs: COMPLETION_TIMEOUT_MS,
        });

        if(result.status === 401) {
            throw new ApiError(401, "authentication_error",
                "登录已失效：请在浏览器窗口重新登录");
        }
        if(result.status === 429) {
            throw new ApiError(429, "rate_limit_error",
                "DeepSeek 网页端返回 429（可能触发限流）");
        }
        if(result.status !== 200) {
            throw new ApiError(502, "api_error",
                `completion 返回 HTTP ${result.status}（content-type: ${result.contentType}）`);
        }

        return reduceSSE(result.text);
    }
}
