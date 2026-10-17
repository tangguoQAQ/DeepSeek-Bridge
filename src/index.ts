import { Hono } from "hono";
import { chromium } from "patchright";
import { z } from "zod";

const runtime = typeof Bun === "object" ?
    `Bun ${Bun.version}` : `Node ${process.version}`;
console.log(`Runtime: ${runtime}`);

const ok = (name: string, pass: boolean) =>
    console.log(`${pass ? "✅" : "❌"} ${name}`);

ok("hono imported", typeof Hono === "function");
ok("patchright imported", typeof chromium.launch === "function");
ok("zod imported", typeof z.object === "function");
