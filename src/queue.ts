import { ApiError } from "./server/errors";

export interface QueueSnapshot {
    active: number;
    pending: number;
}

// 串行队列：并发 1 + 最小间隔节流 + 排队上限（§5.5）
export class SerialQueue {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private lastStartAt = 0;

    constructor(
        private readonly maxPending = 4,
        private readonly minIntervalMs = 1000,
    ) {}

    get snapshot(): QueueSnapshot {
        return { active: this.active, pending: this.waiters.length };
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        if(this.active + this.waiters.length >= 1 + this.maxPending) {
            throw new ApiError(429, "rate_limit_error",
                `请求队列已满（排队上限 ${this.maxPending}），请稍后重试`);
        }

        if(this.active === 0) {
            this.active = 1;
        } else {
            await new Promise<void>((resolve) => {
                this.waiters.push(() => resolve());
            });
        }

        const wait = this.lastStartAt + this.minIntervalMs - Date.now();
        if(wait > 0) {
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
        this.lastStartAt = Date.now();

        try {
            return await task();
        } finally {
            const next = this.waiters.shift();
            if(next) {
                next();
            } else {
                this.active = 0;
            }
        }
    }
}
