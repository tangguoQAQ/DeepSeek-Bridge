// ===== SSE Framework =====
export interface SSEEvent {
    event: string;
    data: string;
}

export class SSEParser {
    private buf = "";

    push(chunk: string): SSEEvent[] {
        this.buf += chunk;
        const out: SSEEvent[] = [];

        let m: RegExpExecArray | null;
        while((m = /\r?\n\r?\n/.exec(this.buf)) !== null) {
            const raw = this.buf.slice(0, m.index);
            this.buf = this.buf.slice(m.index + m[0].length);
            const ev = parseBlock(raw);
            if(ev) out.push(ev);
        }

        return out;
    }

    flush(): SSEEvent[] {
        const raw = this.buf;
        this.buf = "";

        const ev = raw.trim().length > 0 ?
            parseBlock(raw) : null;
        return ev ? [ev] : [];
    }
}

function parseBlock(raw: string): SSEEvent | null {
    let event = "";
    const dataLines: string[] = [];
    for(const line of raw.split(/\r?\n/)) {
        // Skip empty lines or comments (:...)
        if(line === "" || line.startsWith(":")) {
            continue;
        }

        const idx = line.indexOf(":");
        const field = idx === -1 ? line : line.slice(0, idx);
        let value = idx === -1 ? "" : line.slice(idx + 1);
        if(value.startsWith(" ")) {
            value = value.slice(1);
        }

        if(field === "event") {
            event = value;
        } else if(field === "data") {
            dataLines.push(value);
        }
    }

    return dataLines.length > 0 ? {
        event,
        data: dataLines.join("\n")
    } : null;
}

export function parseSSE(text: string): SSEEvent[] {
    const p = new SSEParser();
    return [...p.push(text), ...p.flush()];
}

// ===== Delta =====

export type DeltaOp = "SET" | "APPEND" | "BATCH";
export interface RawDelta { p?: string; o?: DeltaOp; v: unknown }
export interface Delta { path: string; op: "SET" | "APPEND"; value: unknown }

export class DeltaParser {
    private op: DeltaOp = "SET";
    private path = "";

    parse(raw: RawDelta): Delta[] {
        this.op = raw.o ?? this.op;
        this.path = raw.p ?? this.path;
        const { op, path } = this;

        if(op !== "BATCH") {
            return [{ path, op, value: raw.v }];
        }

        if(!Array.isArray(raw.v)) {
            throw new Error("The value of BATCH op must be an array");
        }
        const result: Delta[] = [];
        const subParser = new DeltaParser();
        for(const child of raw.v as RawDelta[]) {
            for(const parsedChild of subParser.parse(child)) {
                parsedChild.path = (path ? `${path}/` : "") + parsedChild.path;
                result.push(parsedChild);
            }
        }

        return result;
    }
}

export function applyDelta(doc: unknown, delta: Delta): unknown {
    if(delta.path === "") {
        if(delta.op !== "SET") {
            throw new Error("Delta of root path must be SET");
        }

        return delta.value;
    }

    const segs = delta.path.split("/");
    const lastSeg = segs.pop() as string;
    let node: any = doc;
    if(!node) {
        throw new Error(`Cannot find path: ${delta.path}`);
    }
    for(const seg of segs) {
        node = Array.isArray(node) ?
            node[resolveIndex(node, seg)] : node[seg];
    }
    if(!node) {
        throw new Error(`Cannot find path: ${delta.path}`);
    }
    const key: string | number = Array.isArray(node) ?
        resolveIndex(node, lastSeg) : lastSeg;
    
    if(delta.op === "SET") {
        node[key] = delta.value;
    } else { // delta.op === "APPEND"
        const cur = node[key];
        if(typeof cur === "string") {
            node[key] = cur + delta.value;
        } else if(Array.isArray(cur)) {
            cur.push(delta.value);
        } else {
            throw new Error("Cannot append to non-string and non-array");
        }
    }

    return doc;
}

function resolveIndex(arr: unknown[], key: string): number {
    const i = Number(key);
    if(!Number.isInteger(i)) {
        throw new Error(`Invalid index: ${key}`);
    }

    const idx = i < 0 ? arr.length + i : i;
    if(idx < 0 || i >= arr.length) {
        throw new Error(`Index out of range: ${key}`);
    }

    return idx;
}


export interface CompletionOutcome {
    text: string; // body (RESPONSE fragments concatenated)
    completionTokens: number; // accumulated_token_usage
    finished: boolean;
    closed: boolean; // received close event
    title: string | null;
    responseMessageId: number | null;
}

interface ResponseNode {
    status?: string;
    quasi_status?: string;
    accumulated_token_usage?: number;
    fragments?: Array<{ type?: string; content?: string }>;
}

export function reduceSSE(sseText: string)
    : CompletionOutcome {
    const deltaParser = new DeltaParser();
    let doc: unknown = {};
    let title: string | null = null;
    let responseMessageId: number | null = null;
    let closed = false;

    for(const ev of parseSSE(sseText)) {
        if(ev.event === "") {
            const raw = JSON.parse(ev.data) as RawDelta;
            for(const delta of deltaParser.parse(raw)) {
                doc = applyDelta(doc, delta);
            }
        } else if(ev.event === "ready") {
            const json = JSON.parse(ev.data) as {
                response_message_id?: number
            };
            responseMessageId = json.response_message_id ?? null;
        } else if(ev.event === "title") {
            const json = JSON.parse(ev.data) as {
                content?: string
            };
            title = json.content ?? null;
        } else if(ev.event === "close") {
            closed = true;
        }
        // Ignore other events
    }

    const response = (doc as { response?: ResponseNode } | null)?.response;
    const fragments = response?.fragments ?? [];
    return {
        text: fragments.filter((f) => f.type === "RESPONSE")
            .map((f) => f.content ?? "").join(""),
        completionTokens: response?.accumulated_token_usage ?? 0,
        finished: response?.status === "FINISHED"
            || response?.quasi_status === "FINISHED",
        closed,
        title,
        responseMessageId
    };
}
