import { parseConfig } from "./config";
import { createApp } from "./server/app";
import { SerialQueue } from "./queue";
import { WebApiDriver } from "./driver/web-api";
import { SessionStore } from "./driver/session-store";
import { launchChatBrowser } from "./browser/launcher";
import { checkLogin, waitForLogin } from "./browser/auth";
import type { BridgeConfig } from "./config";
import type { BridgeState } from "./server/app";
import type { ChatBackend } from "./driver/types";
import type { ChatBrowser } from "./browser/launcher";

const DEEPSEEK_BRIDGE_VERSION = "0.0.1";

let config: BridgeConfig;
try {
    config = parseConfig(Bun.argv.slice(2));
} catch(err) {
    console.error(`dsbridge: ${(err as Error).message}`);
    process.exit(1);
}

const state: BridgeState = {
    status: "BOOT",
    startedAt: Date.now(),
    lastError: null,
};

const queue = new SerialQueue(4, config.minRequestIntervalMs);
let backend: ChatBackend | null = null;

const app = createApp(config, state, queue, () => backend);
const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    fetch: app.fetch
});

console.log(`
DeepSeek Bridge v${DEEPSEEK_BRIDGE_VERSION}
Developed by Tgmoss. Shift your deepseek web page into a llm API.

Api token: ${config.token === null ? "disabled" : "enabled"}
Server will listen on http://${server.hostname}:${server.port}
Endpoints:
- GET /healthz    \tStatus and health of the server
- GET /v1/models  \tList of available models
- POST /v1/chat/completions  \tOpenAI compatible chat completions

Only for personal research. Please obey DeepSeek's terms of service. 
`);

let browser: ChatBrowser | null = null;
let shuttingDown = false;

async function shutdown(code: number) {
    if(shuttingDown) {
        return;
    }

    shuttingDown = true;
    console.log("Shutting down browser...");
    if(browser) {
        await browser.context.close().catch(() => {});
    }
    process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ===== Launching =====
state.status = "LAUNCHING";
console.log(`[boot] Launching browser...
  channel = ${config.browserChannel}
  profileDir = ${config.profileDir}`);
try {
    browser = await launchChatBrowser(config);
} catch(err) {
    state.status = "ERROR";
    state.lastError = (err as Error).message;
    console.error(`[boot] ${state.lastError}`);
    process.exit(1);
}

browser.context.on("close", () => {
    if(!shuttingDown) {
        state.status = "ERROR";
        state.lastError = "Browser closed.";
        console.error(`[boot] Browser closed. Exiting...`);
        process.exit(0);
    }
});

// ===== Check Login =====
state.status = "CHECK_LOGIN";
console.log("[boot] Checking login status...");
try {
    if(await checkLogin(browser.page)) {
        state.status = "READY";
        console.log("[boot] Logged in, READY.");
    } else {
        await waitForLogin(browser.page, state);
    }
} catch(err) {
    state.status = "ERROR";
    state.lastError = (err as Error).message;
    console.error(`[boot] ${state.lastError}`);
    await browser.context.close().catch(() => {});
    process.exit(1);
}

// ===== Driver =====
const sessionStore = new SessionStore({
    filePath: "./.cache/dsbridge-sessions.json",
    maxSessions: config.maxSessions,
    charBudget: config.promptCharBudget,
    reuse: config.sessionReuse,
});
backend = new WebApiDriver(browser.page, sessionStore);
console.log(`[boot] Driver attached, accepting requests. (session reuse: ${config.sessionReuse ? "on" : "off"}, max sessions: ${config.maxSessions})`);
