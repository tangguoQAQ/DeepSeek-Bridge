export type BrowserChannel = "auto" | "chrome" | "msedge" | "chromium";

const BROWSER_CHANNELS: readonly string[] =
    ["auto", "chrome", "msedge", "chromium"];

export interface BridgeConfig {
    port: number;
    host: string;
    token: string | null;
    profileDir: string;
    headless: boolean;
    browserChannel: BrowserChannel;
    minRequestIntervalMs: number;
    promptCharBudget: number;
}

function findArg(argv: string[], name: string): string | null {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : (argv[i + 1] ?? null);
}

export function parseConfig(argv: string[]): BridgeConfig {
    const portRaw = findArg(argv, "port");
    const port = portRaw === null ? 7638 : Number(portRaw);
    if(!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port: ${portRaw}`);
    }

    const browserChannel = findArg(argv, "browser-channel") ?? "auto";
    if(!BROWSER_CHANNELS.includes(browserChannel)) {
        throw new Error(`Invalid --browser-channel: ${browserChannel}（auto/chrome/msedge/chromium）`);
    }

    return {
        port,
        host: findArg(argv, "host") ?? "127.0.0.1",
        token: findArg(argv, "token"),
        profileDir: findArg(argv, "profile") ?? "./.deepseek-profile",
        headless: argv.includes("--headless"),
        browserChannel: browserChannel as BrowserChannel,
        minRequestIntervalMs: 1000,
        promptCharBudget: 24000,
    };
}
