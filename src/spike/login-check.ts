import { chromium } from "patchright";

const context = await chromium.launchPersistentContext(
    "./.deepseek-profile", {
        channel: "msedge",
        headless: false,
        chromiumSandbox: true,
        args: ["--test-type"]
    }
);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://chat.deepseek.com/");

console.log("Page title:", await page.title());

while(true) {
    const token = await page.evaluate(() => {
        const raw = localStorage.getItem("userToken");
        if(!raw) return null;

        try {
            const parsed = JSON.parse(raw);
            return typeof parsed?.value === "string" &&
                parsed.value.length > 0 ? parsed.value : null;
        } catch {
            return null;
        }
    });
    console.log(token);

    if(token) {
        console.log("\n Logged in.");
        await new Promise((r) => setTimeout(r, 10000));
        break;
    }
    
    await new Promise((r) => setTimeout(r, 3000));
}

await context.close();
