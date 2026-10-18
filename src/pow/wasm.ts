// T1 求解层：进程内跑官方 sha3 wasm（assets/sha3_wasm_bg.wasm）

const WASM_PATH = "assets/sha3_wasm_bg.wasm";

interface WasmExports {
    memory: WebAssembly.Memory;
    wasm_solve: (retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number) => void;
    __wbindgen_add_to_stack_pointer: (delta: number) => number;
    __wbindgen_export_0: (size: number, align: number) => number;
}

let exportsPromise: Promise<WasmExports> | null = null;

function loadWasm(): Promise<WasmExports> {
    if(exportsPromise === null) {
        exportsPromise = (async () => {
            const bytes = await Bun.file(WASM_PATH).arrayBuffer();
            const { instance } = await WebAssembly.instantiate(bytes, {});
            return instance.exports as unknown as WasmExports;
        })();
    }
    return exportsPromise;
}

const encoder = new TextEncoder();

export async function solveWithWasm(challenge: string, prefix: string, difficulty: number): Promise<number | null> {
    const ex = await loadWasm();
    const cb = encoder.encode(challenge);
    const pb = encoder.encode(prefix);
    const cPtr = ex.__wbindgen_export_0(cb.length, 1) >>> 0;
    const pPtr = ex.__wbindgen_export_0(pb.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer, cPtr, cb.length).set(cb);
    new Uint8Array(ex.memory.buffer, pPtr, pb.length).set(pb);

    const retptr = ex.__wbindgen_add_to_stack_pointer(-16) >>> 0;
    ex.wasm_solve(retptr, cPtr, cb.length, pPtr, pb.length, difficulty);
    const view = new DataView(ex.memory.buffer);
    const ok = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    ex.__wbindgen_add_to_stack_pointer(16);

    return ok === 0 ? null : answer;
}
