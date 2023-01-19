import { parentPort } from 'node:worker_threads';
import { FetchingStrategyOptions, WorkerContextFetchingStrategy, WorkerReceivePayloadOp } from '@discordjs/ws';

export interface VanguardWorkerReceivePayload {
    op: WorkerReceivePayloadOp,
    nonce: number,
    shardId: number,
}

export class VanguardFetchingStrategy extends WorkerContextFetchingStrategy {
    private readonly shardId: number;
    constructor(data: FetchingStrategyOptions, shardId: number) {
        super(data);
        this.shardId = shardId;
    }

    public async waitForIdentify(): Promise<void> {
        const nonce = Math.random();
        // just add shardId on the payload
        const payload = {
            op: WorkerReceivePayloadOp.WaitForIdentify,
            shardId: this.shardId,
            nonce,
        };
        // @ts-expect-error
        const promise = new Promise<void>((resolve) => this.waitForIdentifyPromises.set(nonce, resolve));
		parentPort!.postMessage(payload);
		return promise;
    }
}
