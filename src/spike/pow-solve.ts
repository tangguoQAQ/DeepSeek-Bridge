const wasmBytes = await Bun.file("assets/sha3_wasm_bg.wasm").arrayBuffer();
const { instance } = await WebAssembly.instantiate(wasmBytes, {});

type WasmExports = {
  memory: WebAssembly.Memory;
  wasm_deepseek_hash_v1: (retptr: number, ptr: number, len: number) => void;
  wasm_solve: (retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number) => void;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  __wbindgen_export_0: (size: number, align: number) => number; // malloc(size, align)
};
const ex = instance.exports as WasmExports;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 把 JS 字符串写进 wasm 内存
function writeString(s: string): { ptr: number; len: number } {
  const bytes = encoder.encode(s);
  const ptr = ex.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length };
}

// DeepSeekHashV1 摘要 → 64 字符 hex
function hashHex(s: string): string {
  const { ptr, len } = writeString(s);
  const retptr = ex.__wbindgen_add_to_stack_pointer(-16) >>> 0;
  ex.wasm_deepseek_hash_v1(retptr, ptr, len);
  const view = new DataView(ex.memory.buffer); // 调用后内存可能已增长，必须重新取
  const outPtr = view.getUint32(retptr, true);
  const outLen = view.getUint32(retptr + 4, true);
  const hex = decoder.decode(new Uint8Array(ex.memory.buffer, outPtr, outLen));
  ex.__wbindgen_add_to_stack_pointer(16);
  return hex;
}

// 找 i ∈ [0, difficulty)，使 DeepSeekHashV1(prefix + String(i)) === challenge
function solve(challenge: string, prefix: string, difficulty: number): number | null {
  const c = writeString(challenge);
  const p = writeString(prefix);
  const retptr = ex.__wbindgen_add_to_stack_pointer(-16) >>> 0;
  ex.wasm_solve(retptr, c.ptr, c.len, p.ptr, p.len, difficulty);
  const view = new DataView(ex.memory.buffer);
  const ok = view.getInt32(retptr, true);        // 0 = 没找到
  const answer = view.getFloat64(retptr + 8, true);
  ex.__wbindgen_add_to_stack_pointer(16);
  return ok === 0 ? null : answer;
}

// ---- 自测 ----
// [1] 哈希
const h = hashHex("abc");
console.log("[1] hashHex('abc') =", h, "长度", h.length);

// [2] 造题 → 解题（答案埋在 i=54321）
const prefix = "testsalt_1700000000000_"; // 模拟 salt_expireAt_
const answer = 54321;
const challenge = hashHex(prefix + String(answer));
const t0 = performance.now();
const found = solve(challenge, prefix, 100000);
const ms = (performance.now() - t0).toFixed(1);
console.log(`[2] solve() = ${found}，预期 ${answer}，耗时 ${ms}ms`, found === answer ? "✅ 自洽" : "❌ 不一致");

// [3] 反例：difficulty 太小 → 找不到
console.log("[3] difficulty=100 →", solve(challenge, prefix, 100), "（应为 null）");