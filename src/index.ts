import { parseConfig } from "./config";
import { createApp } from "./server/app";
import type { BridgeConfig } from "./config";
import type { BridgeState } from "./server/app";

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
    lastError: null
};

const app = createApp(config, state);

const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    fetch: app.fetch
});

console.log(`
DeepSeekBridge → http://${server.hostname}:${server.port}
  GET /healthz    健康检查
  GET /v1/models  模型列表
  token: ${config.token === null ? "disabled" : "enabled"}
仅供个人学习研究，请遵守 DeepSeek 服务条款。
`);
