import { chromium } from "patchright";
import type { BrowserContext, Page } from "patchright";
import type { BridgeConfig, BrowserChannel } from "../config";

export const CHAT_URL = "https://chat.deepseek.com/";

const CHANNEL_CHAIN: Record<BrowserChannel, string[]> = {
    auto: ["chrome", "msedge", "chromium"],
    chrome: ["chrome"],
    msedge: ["msedge"],
    chromium: ["chromium"],
};

export interface ChatBrowser {
    context: BrowserContext;
    page: Page;
}

export async function launchChatBrowser(config: BridgeConfig)
    : Promise<ChatBrowser> {
    let lastError: unknown = null;

    for(const channel of CHANNEL_CHAIN[config.browserChannel]) {
        let context: BrowserContext | null = null;

        try {
            context = await chromium.launchPersistentContext(
                config.profileDir, {
                    channel,
                    headless: config.headless,
                    chromiumSandbox: true,
                    args: ["--test-type"],
                }
            );
            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto(CHAT_URL, { waitUntil: "domcontentloaded" });
            
            if(config.browserChannel === "auto") {
                console.log("[browser] auto channel:", channel);
            }
            return { context, page };
        } catch(err) {
            lastError = err;
            if(context) {
                await context.close().catch(() => {});
            }
        }
    }

    throw new Error(`Could not launch browser: ${(lastError as Error)?.message ?? ""}`);
}