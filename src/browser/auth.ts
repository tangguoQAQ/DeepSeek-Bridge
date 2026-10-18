import type { Page } from "patchright";
import type { BridgeState } from "../server/app";

const POLL_INTERVAL_MS = 3000;
const WAIT_LOGIN_TIMEOUT_MS = 30 * 60 * 1000;

export async function getUserToken(page: Page)
    : Promise<string | null> {
    return page.evaluate(() => {
        const raw = localStorage.getItem("userToken");
        if(!raw) {
            return null;
        }

        try {
            const parsed = JSON.parse(raw);
            return typeof parsed?.value === "string" &&
                parsed.value.length > 0 ?
                parsed.value : null;
        } catch {
            return null;
        }
    });
}

export async function checkLogin(page: Page): Promise<Boolean> {
    try {
        const token = await getUserToken(page);
        if(token === null) {
            return false;
        }

        const viaApi = await page.evaluate(async (tok: string) => {
            try {
                const response = await fetch("/api/v0/users/current", {
                    headers: { authorization: "Bearer " + tok }
                });
                if(!response.ok) {
                    return null;
                }

                const json = await response.json();
                return json?.data?.biz_data != null;
            } catch {
                return null;
            }
        }, token)

        return viaApi ?? true;
    } catch {
        return false;
    }
}

export async function waitForLogin(page: Page, state: BridgeState)
    : Promise<void> {
    console.log("⚠️ Failed to detect login status. Please login manually.");
    await page.bringToFront();

    const deadline = Date.now() + WAIT_LOGIN_TIMEOUT_MS;
    while(Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if(await checkLogin(page)) {
            state.status = "READY";
            console.log("✅ Logged in, READY.");
            return;
        }
    }

    throw new Error("Timed out waiting for login, 30 minutes elapsed.");
}