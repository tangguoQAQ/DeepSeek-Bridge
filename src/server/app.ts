import { Hono } from "hono";
import type { BridgeConfig } from "../config";
 import { ApiError } from "./errors";

export type BridgeStatus =
    | "BOOT" | "LAUNCHING"
    | "CHECK_LOGIN" | "WAIT_LOGIN"
    | "READY" | "BUSY" | "ERROR";

export interface BridgeState {
    status: BridgeStatus;
    startedAt: number;
    lastError: string | null;
}

export const MODEL_IDS = [
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-search",
    "deepseek-reasoner-search",
] as const;

export function createApp(config: BridgeConfig, state: BridgeState) {
    const app = new Hono();
    
    // Security: Host header verification, against DNS rebinding
    app.use("*", async (c, next) => {
        const host = (c.req.header("host") ?? "").toLowerCase();
        const allowed = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
        if (!allowed.includes(host)) {
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
        queue: { pending: 0, active: 0 },
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
