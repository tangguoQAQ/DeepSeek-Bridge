import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChainMessage {
    role: string;
    content: string;
}

export interface SessionRecord {
    id: string;
    chainHash: string;
    messageCount: number;
    parentMessageId: number;
    chars: number;
    createdAt: number;
    updatedAt: number;
}

export interface SessionStoreOptions {
    filePath: string;
    maxSessions: number;
    charBudget: number;
    reuse: boolean;
}

interface StoreFile {
    version: 1;
    sessions: SessionRecord[];
}

export const GENESIS_HASH = "0".repeat(64);

export function hashChain(prev: string, role: string, content: string): string {
    return createHash("sha256")
        .update("dsbridge-session-v1\n")
        .update(prev)
        .update("\n")
        .update(role)
        .update("\n")
        .update(content)
        .digest("hex");
}

export function hashMessages(messages: readonly ChainMessage[]): string {
    let hash = GENESIS_HASH;
    for(const message of messages) {
        hash = hashChain(hash, message.role, message.content);
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

    find(chainHash: string, messageCount: number): SessionRecord | null {
        if(!this.reuse) {
            return null;
        }
        for(const record of this.sessions.values()) {
            if(record.chainHash === chainHash && record.messageCount === messageCount) {
                return record;
            }
        }
        return null;
    }

    // 写入/更新记录；返回因 maxSessions 被淘汰的记录
    record(value: {
        id: string;
        chainHash: string;
        messageCount: number;
        parentMessageId: number;
        chars: number;
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
            if(raw.version !== 1 || !Array.isArray(raw.sessions)) {
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
                version: 1,
                sessions: this.all()
            };
            writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        } catch(err) {
            console.warn(`[session] Failed to save session index: ${(err as Error).message}`);
        }
    }
}
