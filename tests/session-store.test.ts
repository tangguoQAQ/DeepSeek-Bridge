import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, hashChain, hashMessages } from "../src/driver/session-store";

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

afterEach(() => {
    for(const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("链式 hash：确定、对角色/内容敏感", () => {
    const messages = [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好！" }
    ];

    const a = hashMessages(messages);
    const b = hashMessages(messages);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);

    expect(hashMessages([{ role: "user", content: "你好" }])).not.toBe(a);
    expect(hashMessages([
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好?" }
    ])).not.toBe(a);
    expect(hashChain("0".repeat(64), "user", "你好")).toBe(hashMessages([{ role: "user", content: "你好" }]));
});

test("按 chainHash + 消息数命中；reuse 关闭时不命中", () => {
    const filePath = tempFile();
    const sessions = store(filePath);
    const chainHash = hashMessages([
        { role: "user", content: "第一轮" },
        { role: "assistant", content: "回复" }
    ]);
    sessions.record({ id: "s1", chainHash, messageCount: 3, parentMessageId: 42, chars: 100 });

    expect(sessions.find(chainHash, 3)?.id).toBe("s1");
    expect(sessions.find(chainHash, 2)).toBeNull();
    expect(sessions.find("f".repeat(64), 3)).toBeNull();

    const disabled = store(filePath, { reuse: false });
    expect(disabled.find(chainHash, 3)).toBeNull();
});

test("索引落盘后可重新加载", () => {
    const filePath = tempFile();
    const first = store(filePath);
    const chainHash = hashMessages([{ role: "user", content: "hi" }]);
    first.record({ id: "s1", chainHash, messageCount: 2, parentMessageId: 7, chars: 20 });

    const second = store(filePath);
    const found = second.find(chainHash, 2);
    expect(found?.id).toBe("s1");
    expect(found?.parentMessageId).toBe(7);
    expect(second.size).toBe(1);
});

test("超过 maxSessions 时淘汰最旧记录", () => {
    const sessions = store(tempFile(), { maxSessions: 2 });

    const evicted0 = sessions.record({ id: "s1", chainHash: "a".repeat(64), messageCount: 2, parentMessageId: 1, chars: 10 });
    const evicted1 = sessions.record({ id: "s2", chainHash: "b".repeat(64), messageCount: 2, parentMessageId: 2, chars: 10 });
    const evicted2 = sessions.record({ id: "s3", chainHash: "c".repeat(64), messageCount: 2, parentMessageId: 3, chars: 10 });

    expect(evicted0).toHaveLength(0);
    expect(evicted1).toHaveLength(0);
    expect(evicted2.map((r) => r.id)).toEqual(["s1"]);
    expect(sessions.size).toBe(2);
    expect(sessions.find("a".repeat(64), 2)).toBeNull();
});

test("maxSessions = 0 表示不限制", () => {
    const sessions = store(tempFile(), { maxSessions: 0 });
    for(let i = 0; i < 5; i++) {
        sessions.record({ id: `s${i}`, chainHash: String(i).repeat(64), messageCount: 2, parentMessageId: i, chars: 10 });
    }
    expect(sessions.size).toBe(5);
});
