import { test, expect } from "bun:test";
import { SerialQueue } from "../src/queue";
import { ApiError } from "../src/server/errors";

test("串行：同一时刻只有一个任务", async () => {
    const queue = new SerialQueue(4, 0);
    let running = 0;
    let maxRunning = 0;
    const task = () => queue.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running--;
    });

    await Promise.all([task(), task(), task()]);
    expect(maxRunning).toBe(1);
});

test("排队上限：超出立即 429", async () => {
    const queue = new SerialQueue(1, 0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    const t1 = queue.run(async () => {
        await gate;
    });
    const t2 = queue.run(async () => {});
    try {
        await queue.run(async () => {});
        throw new Error("should not reach");
    } catch(err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(429);
    }
    release();
    await Promise.all([t1, t2]);
});

test("释放后可继续接单", async () => {
    const queue = new SerialQueue(1, 0);
    await queue.run(async () => 1);
    await queue.run(async () => 2);
    expect(queue.snapshot).toEqual({ active: 0, pending: 0 });
});

test("最小间隔：连续任务启动拉开时间", async () => {
    const queue = new SerialQueue(4, 50);
    const starts: number[] = [];
    const task = () => queue.run(async () => {
        starts.push(Date.now());
    });

    await Promise.all([task(), task(), task()]);
    expect(starts.length).toBe(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(40);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(40);
});
