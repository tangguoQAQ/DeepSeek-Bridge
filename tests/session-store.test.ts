import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, hashChain, hashMessages, GENESIS_HASH } from "../src/driver/session-store";
import type { PromptMessage } from "../src/protocol/prompt";

const dirs: string[] = [];

function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "dsbridge-session-"));
    dirs.push(dir);
    return join(dir, "sessions.json");
}

function store(filePath: string, over: Partial<{
    maxSessions: number;
    charBudget: number;
    reuse: boolean;
}> = {}): SessionStore {
    return new SessionStore({
        filePath,
        maxSessions: 20,
        charBudget: 1000,
        reuse: true,
        ...over
    });
}

const user = (content: string): PromptMessage => ({ role: "user", content });
const assistant = (content: string): PromptMessage => ({ role: "assistant", content });
const tool = (content: string, toolCallId: string): PromptMessage =>
    ({ role: "tool", content, toolCallId });

afterEach(() => {
    for(const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("链式 hash：确定、对角色/内容/工具调用敏感", () => {
    const messages = [user("你好"), assistant("你好！")];

    const a = hashMessages(messages);
    const b = hashMessages(messages);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);

    expect(hashMessages([user("你好")])).not.toBe(a);
    expect(hashMessages([user("你好"), assistant("你好?")])).not.toBe(a);
    expect(hashChain(GENESIS_HASH, user("你好")))
        .toBe(hashMessages([user("你好")]));

    const withCall = assistant("");
    withCall.toolCalls = [{ id: "call_1", name: "get_weather", arguments: "{}" }];
    const withSameCall = assistant("");
    withSameCall.toolCalls = [{ id: "call_1", name: "get_weather", arguments: "{}" }];
    const withOtherArgs = assistant("");
    withOtherArgs.toolCalls = [{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"北京\"}" }];

    expect(hashMessages([user("天气"), withCall])).toBe(hashMessages([user("天气"), withSameCall]));
    expect(hashMessages([user("天气"), withCall])).not.toBe(hashMessages([user("天气"), withOtherArgs]));
});

test("tool 结果与 toolCallId 参与 hash", () => {
    const base = [user("查天气"), assistant(""), tool("晴", "call_1")];
    base[1]!.toolCalls = [{ id: "call_1", name: "get_weather", arguments: "{}" }];

    expect(hashMessages(base)).toBe(hashMessages(base.map((m) => ({ ...m }))));
    expect(hashMessages(base)).not.toBe(hashMessages([
        user("查天气"),
        base[1]!,
        tool("晴", "call_2")
    ]));
});

test("按 chainHash + 消息数 + toolsHash 命中；reuse 关闭时不命中", () => {
    const filePath = tempFile();
    const sessions = store(filePath);
    const chainHash = hashMessages([user("第一轮"), assistant("回复")]);
    sessions.record({
        id: "s1",
        chainHash,
        messageCount: 3,
        parentMessageId: 42,
        chars: 100,
        toolsHash: "tools-a"
    });

    expect(sessions.find(chainHash, 3, "tools-a")?.id).toBe("s1");
    expect(sessions.find(chainHash, 3, "")).toBeNull();
    expect(sessions.find(chainHash, 3, "tools-b")).toBeNull();
    expect(sessions.find(chainHash, 2, "tools-a")).toBeNull();
    expect(sessions.find("f".repeat(64), 3, "tools-a")).toBeNull();

    const disabled = store(filePath, { reuse: false });
    expect(disabled.find(chainHash, 3, "tools-a")).toBeNull();
});

test("索引落盘后可重新加载（含 toolsHash）", () => {
    const filePath = tempFile();
    const first = store(filePath);
    const chainHash = hashMessages([user("hi"), assistant("hello")]);
    first.record({
        id: "s1",
        chainHash,
        messageCount: 2,
        parentMessageId: 7,
        chars: 20,
        toolsHash: "abc"
    });

    const second = store(filePath);
    const found = second.find(chainHash, 2, "abc");
    expect(found?.id).toBe("s1");
    expect(found?.parentMessageId).toBe(7);
    expect(found?.toolsHash).toBe("abc");
    expect(second.size).toBe(1);
});

test("match 选择最长的、以 assistant 结尾的前缀", () => {
    const sessions = store(tempFile());
    const first = [user("第一轮"), assistant("回复一")];
    const second = [...first, user("第二轮"), assistant("回复二")];
    sessions.record({
        id: "s1",
        chainHash: hashMessages(first),
        messageCount: first.length,
        parentMessageId: 1,
        chars: 10,
        toolsHash: ""
    });
    sessions.record({
        id: "s2",
        chainHash: hashMessages(second),
        messageCount: second.length,
        parentMessageId: 2,
        chars: 20,
        toolsHash: ""
    });

    const messages = [...second, user("第三轮")];
    const matched = sessions.match(messages, "");
    expect(matched?.record.id).toBe("s2");
    expect(matched?.newMessages).toEqual([user("第三轮")]);

    // 工具定义变化（hash 不同）时只能回退到无工具记录；这里没有无工具记录，则不命中
    expect(sessions.match(messages, "tools-x")).toBeNull();
});

test("match 忽略不完整的 assistant 边界与完全相同的重复请求", () => {
    const sessions = store(tempFile());
    const chain = [user("你好"), assistant("你好！")];
    sessions.record({
        id: "s1",
        chainHash: hashMessages(chain),
        messageCount: 2,
        parentMessageId: 1,
        chars: 10,
        toolsHash: ""
    });

    // 历史被客户端改写（末尾不是 assistant）时不复用
    expect(sessions.match([user("你好"), user("改写")], "")).toBeNull();
    // 没有新增消息时不复用
    expect(sessions.match(chain, "")).toBeNull();
});

test("超过 maxSessions 时淘汰最旧记录", () => {
    const sessions = store(tempFile(), { maxSessions: 2 });

    const evicted0 = sessions.record({ id: "s1", chainHash: "a".repeat(64), messageCount: 2, parentMessageId: 1, chars: 10, toolsHash: "" });
    const evicted1 = sessions.record({ id: "s2", chainHash: "b".repeat(64), messageCount: 2, parentMessageId: 2, chars: 10, toolsHash: "" });
    const evicted2 = sessions.record({ id: "s3", chainHash: "c".repeat(64), messageCount: 2, parentMessageId: 3, chars: 10, toolsHash: "" });

    expect(evicted0).toHaveLength(0);
    expect(evicted1).toHaveLength(0);
    expect(evicted2.map((r) => r.id)).toEqual(["s1"]);
    expect(sessions.size).toBe(2);
    expect(sessions.find("a".repeat(64), 2, "")).toBeNull();
});

test("maxSessions = 0 表示不限制", () => {
    const sessions = store(tempFile(), { maxSessions: 0 });
    for(let i = 0; i < 5; i++) {
        sessions.record({ id: `s${i}`, chainHash: String(i).repeat(64), messageCount: 2, parentMessageId: i, chars: 10, toolsHash: "" });
    }
    expect(sessions.size).toBe(5);
});
