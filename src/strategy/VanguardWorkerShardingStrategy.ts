import {
    WorkerShardingStrategy,
    WebSocketManager,
    WorkerSendPayloadOp,
    WorkerSendPayload,
    WorkerReceivePayloadOp,
    WorkerReceivePayload
} from '@discordjs/ws';
import { Events } from 'discord.js';
import { VanguardExtendedErrorData, VanguardExtendedOp } from '../worker/VanguardBootstrap';
import { VanguardWorkerReceivePayload } from '../worker/VanguardFetchingStrategy';
import { VanguardWorkerOptions, WebsocketProxy } from '../ws/WebsocketProxy';

// @ts-expect-error: onMessage overwritten to inject custom identify throttling
export class VanguardWorkerShardingStrategy extends WorkerShardingStrategy {
    private readonly proxy: WebsocketProxy;
    constructor(proxy: WebsocketProxy, manager: WebSocketManager, options: VanguardWorkerOptions) {
        super(manager, options);
        this.proxy = proxy;
    }

    private async onMessage(worker: Worker, payload: WorkerReceivePayload) {
        // if we have a customIdentifyThrottler, use that instead
        if (this.proxy.identifyManager && payload.op === WorkerReceivePayloadOp.WaitForIdentify) {
            const customPayload = payload as VanguardWorkerReceivePayload;
            await this.proxy.identifyManager.waitForIdentify(customPayload.shardId);
            const response: WorkerSendPayload = {
                op: WorkerSendPayloadOp.ShardCanIdentify,
                nonce: payload.nonce,
            };
            return worker.postMessage(response);
        }
        // @ts-expect-error: error op added to handle errors
        if (payload.op === VanguardExtendedOp.Error) {
            const data = payload as unknown as VanguardExtendedErrorData;
            const error = new Error(data.error.message);
            error.name = data.error.name;
            error.stack = data.error.stack;
            const shard = this.proxy.ensureShard(data.shardId);
            return shard.onError(error);
        }
        // @ts-expect-error: private properties modified
        return super.onMessage(worker, payload);
    }
}
