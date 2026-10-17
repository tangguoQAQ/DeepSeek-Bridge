import { test, expect } from "bun:test";
import { parseSSE, DeltaParser, applyDelta, reduceSSE } from "../src/protocol/patch-stream";

const readFixture = (name: string) => Bun.file(`tests/fixtures/${name}`).text();

test("真机 fixture：正文 / token / 状态 / 标题", async () => {
    const r = reduceSSE(await readFixture("completion-live-sample.txt"));
    expect(r.text).toBe("1+1等于2。");
    expect(r.completionTokens).toBe(48);
    expect(r.finished).toBe(true);
    expect(r.closed).toBe(true);
    expect(r.title).toBe("一加一等于二");
    expect(r.responseMessageId).toBe(2);
});

test("S2 抓包 fixture：正文与用量", async () => {
    const r = reduceSSE(await readFixture("completion-sse-sample.txt"));
    expect(r.text).toBe("You're welcome! Let me know if there's anything else I can help with.");
    expect(r.completionTokens).toBe(79);
    expect(r.finished).toBe(true);
    expect(r.title).toBe(null);
});

test("粘性语义：缺省 p/o 继承上一条", () => {
    const p = new DeltaParser();
    const first = p.parse({ p: "response/fragments/-1/content", o: "APPEND", v: "a" });
    const second = p.parse({ v: "b" });
    expect(first).toEqual([{ path: "response/fragments/-1/content", op: "APPEND", value: "a" }]);
    expect(second).toEqual([{ path: "response/fragments/-1/content", op: "APPEND", value: "b" }]);
});

test("BATCH 展开为绝对路径；-1 追加到末元素", () => {
    const p = new DeltaParser();
    const ds = p.parse({
        p: "response",
        o: "BATCH",
        v: [{ p: "accumulated_token_usage", v: 48 }, { p: "quasi_status", v: "FINISHED" }],
    });
    expect(ds).toEqual([
        { path: "response/accumulated_token_usage", op: "SET", value: 48 },
        { path: "response/quasi_status", op: "SET", value: "FINISHED" },
    ]);

    let doc: unknown = { response: { fragments: [{ type: "RESPONSE", content: "x" }] } };
    doc = applyDelta(doc, { path: "response/fragments/-1/content", op: "APPEND", value: "y" });
    expect((doc as any).response.fragments[0].content).toBe("xy");
});

test("SSE 框架：CRLF、多行 data、无尾空行的末块", () => {
    const evs = parseSSE("event: t\r\ndata: a\r\ndata: b\r\n\r\ndata: {}");
    expect(evs).toEqual([
        { event: "t", data: "a\nb" },
        { event: "", data: "{}" },
    ]);
});