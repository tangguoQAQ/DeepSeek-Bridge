import { mkdirSync } from "node:fs";

const wasmPath = "static/sha3_wasm_bg.7b9ca65ddd.wasm";
const candidates = [
  `https://fe-static.deepseek.com/chat/${wasmPath}`,
  `https://chat.deepseek.com/${wasmPath}`,
];

let saved = false;
for (const url of candidates) {
  console.log("尝试:", url);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  ✗ HTTP ${res.status}`);
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // wasm 文件开头必须是魔数 00 61 73 6d（即 "\0asm"），拿这个验货
    if (buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
      console.log("  ✗ 拿到的不是 wasm（可能是错误页 HTML）");
      continue;
    }
    mkdirSync("assets", { recursive: true });
    await Bun.write("assets/sha3_wasm_bg.wasm", buf);
    console.log(`  ✅ 已保存 assets/sha3_wasm_bg.wasm（${buf.byteLength} 字节）`);
    saved = true;
    break;
  } catch (e) {
    console.log("  ✗ 请求失败:", String(e));
  }
}
if (!saved) console.log("两个候选都失败——把输出贴我");