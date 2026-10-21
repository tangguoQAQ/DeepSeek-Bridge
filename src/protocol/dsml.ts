const FULL_BAR = "\uFF5C";
const DSML_BARS = `(?:\\s*(?:\\||${FULL_BAR})){1,3}\\s*`;
const DSML_MARK = `${DSML_BARS}DSML${DSML_BARS}`;

const OPEN_TAG = new RegExp(`<\\s*${DSML_MARK}(?:tool_)?calls\\s*>`, "i");
const CLOSE_TAG = new RegExp(`<\\/\\s*${DSML_MARK}(?:tool_)?calls\\s*>`, "i");

const MAX_CALLS = 8;

export interface DsmlMatch {
    index: number;
    length: number;
}

export interface DsmlCall {
    name: string;
    arguments: string;
}

export function findDsmlOpen(text: string): DsmlMatch | null {
    const match = OPEN_TAG.exec(text);
    return match === null ? null : { index: match.index, length: match[0].length };
}

export function findDsmlClose(text: string): DsmlMatch | null {
    const match = CLOSE_TAG.exec(text);
    return match === null ? null : { index: match.index, length: match[0].length };
}

// 只扣住“可能是 DSML 开头”的尾巴，避免把半个标记先当正文发出去
const { prefixes: OPEN_PREFIXES, maxLength: MAX_OPEN_PREFIX } = buildOpenPrefixes();

export function partialDsmlOpenSuffix(text: string): number {
    const max = Math.min(text.length, MAX_OPEN_PREFIX);
    for(let length = max; length > 0; length--) {
        if(OPEN_PREFIXES.has(text.slice(-length))) {
            return length;
        }
    }
    return 0;
}

function buildOpenPrefixes(): { prefixes: Set<string>; maxLength: number } {
    const markers = new Set<string>(["<tool_calls>"]);
    const bars = ["|", "||", "|||", FULL_BAR, FULL_BAR.repeat(2), FULL_BAR.repeat(3)];
    const tags = ["tool_calls", "calls"];
    const names = ["DSML", "dsml"];

    for(const left of bars) {
        for(const right of bars) {
            for(const name of names) {
                const middles = [
                    `${left}${name}${right}`,
                    `${left}${name} ${right}`,
                    `${left} ${name}${right}`,
                    `${left} ${name} ${right}`
                ];
                for(const middle of middles) {
                    for(const before of ["<", "< "]) {
                        for(const tag of tags) {
                            for(const separator of ["", " "]) {
                                markers.add(`${before}${middle}${separator}${tag}>`);
                            }
                        }
                    }
                }
            }
        }
    }

    const prefixes = new Set<string>();
    let maxLength = 0;
    for(const marker of markers) {
        for(let length = 1; length <= marker.length; length++) {
            prefixes.add(marker.slice(0, length));
            maxLength = Math.max(maxLength, length);
        }
    }
    return { prefixes, maxLength };
}

export function parseDsmlBlock(raw: string, names: ReadonlySet<string>): DsmlCall[] | null {
    const text = normalizeDsml(raw);
    const invokeRe = /<dsml_invoke\b([^>]*)>([\s\S]*?)<\/dsml_invoke>/gi;
    const calls: DsmlCall[] = [];

    let invoke: RegExpExecArray | null;
    while((invoke = invokeRe.exec(text)) !== null) {
        const attrs = invoke[1] ?? "";
        const name = readAttr(attrs, "name");
        if(name === null || !names.has(name)) {
            return null;
        }

        const args: Record<string, unknown> = {};
        const body = invoke[2] ?? "";
        const parameterRe = /<dsml_parameter\b([^>]*)>([\s\S]*?)<\/dsml_parameter>/gi;
        let parameter: RegExpExecArray | null;
        while((parameter = parameterRe.exec(body)) !== null) {
            const parameterAttrs = parameter[1] ?? "";
            const parameterName = readAttr(parameterAttrs, "name");
            if(parameterName === null) {
                return null;
            }
            const stringFlag = (readAttr(parameterAttrs, "string") ?? "").toLowerCase();
            const value = stringFlag === "true"
                ? decodeEntities(parameter[2] ?? "")
                : parseLooseValue(parameter[2] ?? "");
            args[parameterName] = value;
        }

        calls.push({ name, arguments: JSON.stringify(args) });
        if(calls.length > MAX_CALLS) {
            return null;
        }
    }

    return calls.length > 0 ? calls : null;
}

function normalizeDsml(raw: string): string {
    return raw
        .replace(new RegExp(`<\\/\\s*${DSML_MARK}(?:tool_)?calls\\s*>`, "gi"), "</dsml_calls>")
        .replace(new RegExp(`<\\s*${DSML_MARK}(?:tool_)?calls\\s*>`, "gi"), "<dsml_calls>")
        .replace(new RegExp(`<\\/\\s*${DSML_MARK}invoke\\s*>`, "gi"), "</dsml_invoke>")
        .replace(new RegExp(`<\\s*${DSML_MARK}invoke\\b([^>]*)>`, "gi"), "<dsml_invoke$1>")
        .replace(new RegExp(`<\\/\\s*${DSML_MARK}parameter\\s*>`, "gi"), "</dsml_parameter>")
        .replace(new RegExp(`<\\s*${DSML_MARK}parameter\\b([^>]*)>`, "gi"), "<dsml_parameter$1>");
}

function readAttr(attrs: string, name: string): string | null {
    const pattern = new RegExp(
        `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
        "i"
    );
    const match = pattern.exec(attrs);
    return match === null ? null : (match[1] ?? match[2] ?? match[3] ?? "");
}

function parseLooseValue(raw: string): unknown {
    const trimmed = raw.trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        return decodeEntities(raw);
    }
}

function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}
