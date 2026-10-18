import { test, expect } from "bun:test";
import { buildPrompt } from "../src/protocol/prompt";

const system = (content: string) => ({ role: "system" as const, content });
const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

test("基本拼装：system 置顶、末尾是最后一条 user", () => {
    const { prompt, truncated } = buildPrompt([
        system("你是助手"),
        user("你好"),
        assistant("你好！"),
        user("1+1？"),
    ]);
    expect(prompt).toContain("[System] 你是助手");
    expect(prompt).toContain("[User] 你好");
    expect(prompt).toContain("[Assistant] 你好！");
    expect(prompt.endsWith("[User] 1+1？\n\n")).toBe(true);
    expect(truncated).toBe(false);
});

test("多条 system 合并置顶", () => {
    const { prompt } = buildPrompt([system("A"), system("B"), user("x")]);
    expect(prompt).toContain("[System] A\nB");
    expect(prompt.indexOf("[System]")).toBeLessThan(prompt.indexOf("[User] x"));
});

test("prefill：末尾是 assistant 时追加继续指令", () => {
    const { prompt } = buildPrompt([user("写个标题"), assistant("标题：")]);
    expect(prompt).toContain("[User] （请继续完成上一条助手消息）");
    expect(prompt.endsWith("（请继续完成上一条助手消息）\n\n")).toBe(true);
});

test("超预算从中间裁剪：保首轮与末尾", () => {
    const msgs = [system("sys"), user("第一问"), assistant("第一答")];
    for(let i = 0; i < 50; i++) {
        msgs.push(user(`问题${i} `.repeat(20)));
        msgs.push(assistant(`回答${i} `.repeat(20)));
    }
    msgs.push(user("最后一问"));

    const { prompt, truncated } = buildPrompt(msgs, 2000);
    expect(truncated).toBe(true);
    expect(prompt).toContain("……（截断部分）……");
    expect(prompt).toContain("[User] 第一问");
    expect(prompt.endsWith("[User] 最后一问\n\n")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(2200);
});

test("单条消息超预算：截断并标注", () => {
    const { prompt } = buildPrompt([user("啊".repeat(8000))], 3000);
    expect(prompt).toContain("……（截断部分）……");
});
