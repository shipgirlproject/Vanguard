import { parentPort } from 'node:worker_threads';
import {
    WorkerBootstrapper,
    BootstrapOptions,
    WorkerReceivePayloadOp,
    WebSocketShardEvents,
    WebSocketShard
} from '@discordjs/ws';
import { VanguardFetchingStrategy } from './VanguardFetchingStrategy';

export class VanguardBootstrap extends WorkerBootstrapper {
    public async bootstrap(options: Readonly<BootstrapOptions> = {}): Promise<void> {
        // Start by initializing the shards
        for (const shardId of this.data.shardIds) {
            // use our extended ws shard
            const shard = new WebSocketShard(new VanguardFetchingStrategy(this.data, shardId), shardId);
            for (const event of options.forwardEvents ?? Object.values(WebSocketShardEvents)) {
                // @ts-expect-error: event types incompatible
                shard.on(event, (data) => {
                    const payload = {
                        op: WorkerReceivePayloadOp.Event,
                        event,
                        data,
                        shardId,
                    };
					parentPort!.postMessage(payload);
                });
            }
            // Any additional setup the user might want to do
            await options.shardCallback?.(shard as unknown as WebSocketShard);
            this.shards.set(shardId, shard as unknown as WebSocketShard);
        }

        // Lastly, start listening to messages from the parent thread
        this.setupThreadEvents();

        const message = {
            op: WorkerReceivePayloadOp.WorkerReady,
        };
		parentPort!.postMessage(message);
    }
}

