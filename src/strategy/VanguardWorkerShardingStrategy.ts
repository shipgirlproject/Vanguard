import { WorkerShardingStrategy, WebSocketManager, WorkerSendPayloadOp, WorkerSendPayload, WorkerReceivePayloadOp, WorkerReceivePayload } from '@discordjs/ws';
import { VanguardIdentifyThrottler } from '../Vanguard';
import { VanguardWorkerReceivePayload } from '../worker/VanguardFetchingStrategy';
import { VanguardWorkerOptions } from '../ws/WebsocketProxy';

// @ts-expect-error: onMessage overwritten to inject custom identify throttling
export class VanguardWorkerShardingStrategy extends WorkerShardingStrategy {
    private readonly customIdentifyThrottler: VanguardIdentifyThrottler|undefined;
    constructor(manager: WebSocketManager, options: VanguardWorkerOptions) {
        super(manager, options);
        if (!options.identifyThrottler)
            this.customIdentifyThrottler = undefined;
        else
            this.customIdentifyThrottler = new options.identifyThrottler(manager);
    }

    private async onMessage(worker: Worker, payload: WorkerReceivePayload) {
        // if we have a customIdentifyThrottler, use that instead
        if (this.customIdentifyThrottler && payload.op === WorkerReceivePayloadOp.WaitForIdentify) {
            const customPayload = payload as VanguardWorkerReceivePayload;
            await this.customIdentifyThrottler.waitForIdentify(customPayload.shardId);
            const response: WorkerSendPayload = {
                op: WorkerSendPayloadOp.ShardCanIdentify,
                nonce: payload.nonce,
            };
            worker.postMessage(response);
            return;
        }
        // @ts-expect-error: private properties modified
        return super.onMessage(worker, payload);
    }
}
