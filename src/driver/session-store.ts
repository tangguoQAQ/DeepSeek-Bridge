import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PromptMessage } from "../protocol/prompt";

export interface SessionRecord {
    id: string;
    chainHash: string;
    messageCount: number;
    parentMessageId: number;
    chars: number;
    toolsHash: string;
    createdAt: number;
    updatedAt: number;
}

export interface SessionStoreOptions {
    filePath: string;
    maxSessions: number;
    charBudget: number;
    reuse: boolean;
}

export interface SessionMatch {
    record: SessionRecord;
    newMessages: PromptMessage[];
}

interface StoreFile {
    version: 2;
    sessions: SessionRecord[];
}

export const GENESIS_HASH = "0".repeat(64);

export function hashChain(prev: string, message: PromptMessage): string {
    return createHash("sha256")
        .update("dsbridge-session-v2\n")
        .update(prev)
        .update("\n")
        .update(JSON.stringify({
            role: message.role,
            content: message.content,
            toolCallId: message.toolCallId ?? null,
            toolCalls: message.toolCalls?.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: call.arguments
            })) ?? null
        }))
        .digest("hex");
}

export function hashMessages(messages: readonly PromptMessage[]): string {
    let hash = GENESIS_HASH;
    for(const message of messages) {
        hash = hashChain(hash, message);
    }
    return hash;
}

// 会话索引：chainHash → session。只记录桥创建的会话，用于复用与清理。
export class SessionStore {
    readonly charBudget: number;
    private readonly reuse: boolean;
    private readonly maxSessions: number;
    private readonly filePath: string;
    private readonly sessions = new Map<string, SessionRecord>();

    constructor(options: SessionStoreOptions) {
        this.filePath = options.filePath;
        this.maxSessions = options.maxSessions;
        this.charBudget = options.charBudget;
        this.reuse = options.reuse;
        this.load();
    }

    get size(): number {
        return this.sessions.size;
    }

    find(chainHash: string, messageCount: number, toolsHash: string): SessionRecord | null {
        if(!this.reuse) {
            return null;
        }
        for(const record of this.sessions.values()) {
            if(record.chainHash === chainHash
                && record.messageCount === messageCount
                && record.toolsHash === toolsHash) {
                return record;
            }
        }
        return null;
    }

    // 在客户端历史里找最长的、与索引记录匹配的前缀；剩余部分就是本轮增量
    match(messages: readonly PromptMessage[], toolsHash: string): SessionMatch | null {
        if(!this.reuse || messages.length < 2) {
            return null;
        }

        let hash = GENESIS_HASH;
        let best: SessionRecord | null = null;
        for(let i = 0; i < messages.length - 1; i++) {
            hash = hashChain(hash, messages[i]!);
            const record = this.find(hash, i + 1, toolsHash);
            if(record !== null) {
                best = record;
            }
        }
        if(best === null) {
            return null;
        }

        const newMessages = messages.slice(best.messageCount);
        if(newMessages.length === 0) {
            return null;
        }
        // 记录必须结束在 assistant 回合，下一轮才是继续对话
        if(messages[best.messageCount - 1]?.role !== "assistant") {
            return null;
        }
        return { record: best, newMessages };
    }

    // 写入/更新记录；返回因 maxSessions 被淘汰的记录
    record(value: {
        id: string;
        chainHash: string;
        messageCount: number;
        parentMessageId: number;
        chars: number;
        toolsHash: string;
    }): SessionRecord[] {
        const now = Date.now();
        const existing = this.sessions.get(value.id);
        this.sessions.set(value.id, {
            ...value,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
        });
        const evicted = this.prune();
        this.persist();
        return evicted;
    }

    remove(id: string): void {
        if(this.sessions.delete(id)) {
            this.persist();
        }
    }

    all(): SessionRecord[] {
        return [...this.sessions.values()];
    }

    private prune(): SessionRecord[] {
        if(this.maxSessions <= 0 || this.sessions.size <= this.maxSessions) {
            return [];
        }
        const sorted = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
        const evicted: SessionRecord[] = [];
        while(this.sessions.size > this.maxSessions && sorted.length > 0) {
            const record = sorted.shift()!;
            this.sessions.delete(record.id);
            evicted.push(record);
        }
        return evicted;
    }

    private load(): void {
        if(!existsSync(this.filePath)) {
            return;
        }
        try {
            const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
            if(raw.version !== 2 || !Array.isArray(raw.sessions)) {
                return;
            }
            for(const record of raw.sessions) {
                if(typeof record.id === "string"
                    && typeof record.chainHash === "string"
                    && typeof record.messageCount === "number"
                    && typeof record.parentMessageId === "number"
                    && typeof record.chars === "number") {
                    this.sessions.set(record.id, {
                        ...record,
                        toolsHash: typeof record.toolsHash === "string" ? record.toolsHash : "",
                        createdAt: record.createdAt ?? Date.now(),
                        updatedAt: record.updatedAt ?? Date.now()
                    });
                }
            }
        } catch(err) {
            console.warn(`[session] Failed to load session index: ${(err as Error).message}`);
        }
    }

    private persist(): void {
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            const data: StoreFile = {
                version: 2,
                sessions: this.all()
            };
            writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        } catch(err) {
            console.warn(`[session] Failed to save session index: ${(err as Error).message}`);
        }
    }
}
