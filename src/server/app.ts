import { Hono } from "hono";
import { ApiError } from "./errors";
import { runChatCompletion, runChatCompletionStream, MODEL_PROFILES } from "./completions";
import { parseChatRequest } from "./openai-schema";
import type { BridgeConfig } from "../config";
import type { SerialQueue } from "../queue";
import type { ChatBackend } from "../driver/types";

export type BridgeStatus =
    | "BOOT" | "LAUNCHING"
    | "CHECK_LOGIN" | "WAIT_LOGIN"
    | "READY" | "BUSY" | "ERROR";

export interface BridgeState {
    status: BridgeStatus;
    startedAt: number;
    lastError: string | null;
}

const MODEL_IDS = Object.keys(MODEL_PROFILES);

export function createApp(
    config: BridgeConfig,
    state: BridgeState,
    queue: SerialQueue,
    getBackend: () => ChatBackend | null,
) {
    const app = new Hono();

    // Security: Host header verification, against DNS rebinding
    app.use("*", async (c, next) => {
        const host = (c.req.header("host") ?? "").toLowerCase();
        const allowed = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
        if(!allowed.includes(host)) {
            return c.json({
                error: { message: "forbidden host", type: "invalid_request_error" }
            }, 403);
        }

        return next();
    });

    // Security: Optional token
    app.use("/v1/*", async (c, next) => {
        if(config.token === null) {
            return next();
        }

        const auth = c.req.header("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if(bearer !== config.token) {
            return c.json({
                error: {
                    message: "invalid api key (see --token)",
                    type: "authentication_error"
                }
            }, 401);
        }

        return next();
    });

    app.get("/healthz", (c) => c.json({
        status: state.status,
        uptime: Math.round((Date.now() - state.startedAt) / 1000),
        queue: queue.snapshot,
        lastError: state.lastError
    }));

    const createdAt = Math.floor(Date.now() / 1000);
    app.get("/v1/models", (c) => c.json({
        object: "list",
        data: MODEL_IDS.map((id) => ({
            id,
            object: "model",
            created: createdAt,
            owned_by: "deepseek-web"
        }))
    }));

    app.post("/v1/chat/completions", async (c) => {
        const backend = getBackend();
        if(backend === null) {
            throw new ApiError(503, "api_error", "Bridge not ready (browser launching or waiting for login), please retry later");
        }

        const body = await c.req.json().catch(() => {
            throw new ApiError(400, "invalid_request_error", "Request body is not valid JSON");
        });

        try {
            const req = parseChatRequest(body);
            let response: Response;
            if(req.stream) {
                response = await runChatCompletionStream(req, queue, backend, config.promptCharBudget);
            } else {
                const payload = await runChatCompletion(req, queue, backend, config.promptCharBudget);
                c.header("x-dsbridge-usage", "estimated");
                response = c.json(payload);
            }
            if(state.status === "WAIT_LOGIN") {
                state.status = "READY";
                console.log("[api] Login recovered, READY.");
            }
            return response;
        } catch(err) {
            if(err instanceof ApiError && err.status === 401 && state.status === "READY") {
                state.status = "WAIT_LOGIN";
                console.warn("[api] Login lost, please sign in again in the browser window.");
            }
            throw err;
        }
    });

    app.notFound((c) => c.json({
        error: { message: "not found", type: "invalid_request_error" }
    }, 404));

    app.onError((err, c) => {
        if(err instanceof ApiError) {
            return c.json({ error: { message: err.message, type: err.type } }, err.status);
        }
        state.lastError = err.message;
        console.error("[error]", err);
        return c.json({
            error: { message: err.message, type: "api_error" }
        }, 500);
    });

    return app;
}
