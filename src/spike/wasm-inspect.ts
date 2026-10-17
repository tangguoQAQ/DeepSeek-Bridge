const bytes = await Bun.file("assets/sha3_wasm_bg.wasm")
    .arrayBuffer();
console.log("Wasm size: ", bytes.byteLength);

const { instance } = await WebAssembly.instantiate(bytes);

for(const [name, value] of
    Object.entries(instance.exports)) {
    if(typeof value === "function") {
        console.log("- Function: ", name);
    } else if(value instanceof WebAssembly.Memory) {
        console.log("- Memory: ", name, value.buffer.byteLength);
    } else {
        console.log("- Other: ", name, value);
    }
}