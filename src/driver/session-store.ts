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
    toolCallIds?: string[];
    userHash?: string;
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
    // 工具结果请求通过 tool_call_id / 用户消息回退命中，即使历史前缀已变化
    viaTool: boolean;
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

// 用户消息指纹：忽略 system / assistant 的客户端改写，用于工具结果回退匹配
export function hashUserMessages(messages: readonly PromptMessage[]): string {
    let hash = GENESIS_HASH;
    for(const message of messages) {
        if(message.role !== "user") {
            continue;
        }
        hash = createHash("sha256")
            .update("dsbridge-user-v1\n")
            .update(hash)
            .update("\n")
            .update(message.content)
            .digest("hex");
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
        if(!this.reuse || messages.length === 0) {
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
        if(best !== null) {
            const newMessages = messages.slice(best.messageCount);
            // 记录必须结束在 assistant 回合，下一轮才是继续对话
            if(newMessages.length > 0
                && messages[best.messageCount - 1]?.role === "assistant") {
                return { record: best, newMessages, viaTool: false };
            }
        }

        return this.matchToolContinuation(messages, toolsHash);
    }

    // 工具结果回退：客户端常会改动 system / 重排 assistant 工具消息，
    // 精确前缀会失效；此时用 tool_call_id 或用户消息指纹接回原会话。
    private matchToolContinuation(
        messages: readonly PromptMessage[],
        toolsHash: string
    ): SessionMatch | null {
        let lastIndex = messages.length - 1;
        while(lastIndex >= 0 && messages[lastIndex]!.role === "system") {
            lastIndex--;
        }
        if(lastIndex < 0 || messages[lastIndex]!.role !== "tool") {
            return null;
        }

        const requestCallIds = new Set<string>();
        for(const message of messages) {
            if(message.role === "tool" && message.toolCallId !== undefined) {
                requestCallIds.add(message.toolCallId);
            }
        }
        if(requestCallIds.size === 0) {
            return null;
        }

        const userHash = hashUserMessages(messages);
        const candidates = [...this.sessions.values()].filter((record) => {
            const ids = record.toolCallIds ?? [];
            if(ids.some((id) => requestCallIds.has(id))) {
                return true;
            }
            return ids.length > 0
                && (record.userHash ?? "").length > 0
                && record.userHash === userHash;
        });
        if(candidates.length === 0) {
            return null;
        }

        // 优先工具列表相同的会话，其次选最近更新的
        candidates.sort((a, b) => {
            const sameA = a.toolsHash === toolsHash ? 1 : 0;
            const sameB = b.toolsHash === toolsHash ? 1 : 0;
            return sameB - sameA || b.updatedAt - a.updatedAt;
        });

        for(const record of candidates) {
            const recordIds = new Set(record.toolCallIds ?? []);
            const byId = [...requestCallIds].some((id) => recordIds.has(id));

            let anchor = -1;
            if(byId) {
                for(let i = lastIndex; i >= 0; i--) {
                    const message = messages[i]!;
                    if(message.role === "assistant"
                        && message.toolCalls?.some((call) => recordIds.has(call.id))) {
                        anchor = i;
                        break;
                    }
                }
            }

            let start: number;
            if(anchor >= 0) {
                start = anchor + 1;
            } else {
                start = lastIndex;
                while(start > 0 && messages[start - 1]!.role === "tool") {
                    start--;
                }
            }

            const newMessages = messages
                .slice(start)
                .filter((message) => message.role !== "system");
            if(newMessages.length > 0
                && newMessages.some((message) => message.role === "tool")) {
                return { record, newMessages, viaTool: true };
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
        toolsHash: string;
        toolCallIds?: string[];
        userHash?: string;
    }): SessionRecord[] {
        const now = Date.now();
        let newest = 0;
        for(const record of this.sessions.values()) {
            newest = Math.max(newest, record.updatedAt);
        }
        const existing = this.sessions.get(value.id);
        this.sessions.set(value.id, {
            ...value,
            toolCallIds: value.toolCallIds ?? [],
            userHash: value.userHash ?? "",
            createdAt: existing?.createdAt ?? now,
            // 保证本次写入严格比旧记录新，避免同毫秒写入时误删刚复用的会话
            updatedAt: Math.max(now, newest + 1)
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
        const sorted = [...this.sessions.values()].sort((a, b) =>
            a.updatedAt - b.updatedAt || a.createdAt - b.createdAt);
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
                        toolCallIds: Array.isArray(record.toolCallIds)
                            ? record.toolCallIds.filter((id): id is string => typeof id === "string")
                            : [],
                        userHash: typeof record.userHash === "string" ? record.userHash : "",
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
