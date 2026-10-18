export interface BridgeConfig {
    port: number;
    host: string;
    token: string | null
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

    return {
        port,
        host: findArg(argv, "host") ?? "127.0.0.1",
        token: findArg(argv, "token"),
    };
}