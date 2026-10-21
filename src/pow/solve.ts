import { solveWithWasm } from "./wasm";

export interface PowChallenge {
    algorithm: string;
    challenge: string;
    salt: string;
    signature: string;
    difficulty: number;
    expire_at: number;
}

export interface PowSolution {
    answer: number;
    ms: number;
}

// 降智观测基线（§5.3）：只记录与提醒，不改变行为
const BASELINE_DIFFICULTY = 144000;

export async function solvePow(challenge: PowChallenge): Promise<PowSolution> {
    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const t0 = performance.now();
    const answer = await solveWithWasm(challenge.challenge, prefix, challenge.difficulty);
    const ms = performance.now() - t0;

    if(answer === null) {
        throw new Error("PoW solve failed (T1 wasm found no solution)");
    }

    console.log(`[pow] difficulty=${challenge.difficulty} answer=${answer} ${ms.toFixed(1)}ms`);
    if(challenge.difficulty < BASELINE_DIFFICULTY / 2) {
        console.warn(`[pow] difficulty 明显低于基线 ${BASELINE_DIFFICULTY}（观测项：疑似降智/风控变化，方向未定）`);
    }

    return { answer, ms };
}

export function buildPowHeader(challenge: PowChallenge, answer: number): string {
    const payload = {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: "/api/v0/chat/completion",
    };
    return Buffer.from(JSON.stringify(payload)).toString("base64");
}
