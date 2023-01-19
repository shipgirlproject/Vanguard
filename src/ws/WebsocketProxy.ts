import { join } from 'node:path';
import { Collection, Client, Status, CloseEvent, Events as ClientEvents, WebSocketManager as Legacy, WebSocketShardEvents as LegacyEvents } from 'discord.js';
import { WebSocketShardEvents, WorkerShardingStrategy,WebSocketShardDestroyRecovery, WebSocketManager as Updated, OptionalWebSocketManagerOptions, RequiredWebSocketManagerOptions } from '@discordjs/ws';
import { WebsocketShardProxy } from './WebsocketShardProxy';
import { VanguardWorkerShardingStrategy } from '../strategy/VanguardWorkerShardingStrategy';
import { Constructor, OptionalVanguardWorkerOptions, VanguardIdentifyThrottler } from '../Vanguard';

export interface CustomCloseData {
    code: number;
    shardId: number;
    additional?: {
        recover?: WebSocketShardDestroyRecovery;
        reason?: string;
    }
}

export interface VanguardWorkerOptions {
	shardsPerWorker: number | 'all',
	workerPath: string;
    identifyThrottler?: Constructor<VanguardIdentifyThrottler>;
}

// @ts-expect-error: private properties modified
export class WebsocketProxy extends Legacy {
    public readonly manager: Updated;
    // @ts-expect-error: private properties modified
    public readonly shards: Collection<number, WebsocketShardProxy>;
    private readonly workerOptions: VanguardWorkerOptions;
    private eventsAttached: boolean;
    constructor(client: Client, sharderOptions: OptionalWebSocketManagerOptions, workerOptions?: OptionalVanguardWorkerOptions) {
        super(client);
        this.manager = new Updated(this.createSharderOptions(sharderOptions));
        this.shards = new Collection();
        this.workerOptions = this.createWorkerOptions(workerOptions);
        this.eventsAttached = false;
    }

    private createSharderOptions(sharderOptions: OptionalWebSocketManagerOptions): OptionalWebSocketManagerOptions & RequiredWebSocketManagerOptions {
        return { ...{
            token: this.client.token!, // this is null so I need to redefine token in connect
            intents: this.client.options.intents.bitfield as unknown as number,
            rest: this.client.rest
        },
        ... sharderOptions
        };
    }

    private createWorkerOptions(options: OptionalVanguardWorkerOptions|undefined): VanguardWorkerOptions {
        return {
            shardsPerWorker: options?.shardsPerWorker || 'all',
            workerPath: options?.workerPath || join(__dirname, '../worker/DefaultWorker.js'),
            identifyThrottler: options?.identifyThrottler
        };
    }

    private getOrAutomaticallyCreateShard(id: number): WebsocketShardProxy {
        let shard = this.shards.get(id);
        if (!shard) {
            shard = new WebsocketShardProxy(this, id);
            this.shards.set(id, shard);
        }
        if (!shard.eventsAttached) {
            shard.on(LegacyEvents.AllReady, (unavailable: Set<string>|undefined) => {
                // idk why typescript complains shard can be null here
                shard!.status = Status.Ready;
                this.client.emit(ClientEvents.ShardReady, shard!.id, unavailable);
                this.checkShardsReady();
            });
            shard.eventsAttached = true;
        }
        return shard;
    }

    private attachEventsToWebsocketManager(): void {
        if (this.eventsAttached) return;
        this.manager.on(WebSocketShardEvents.Ready, data => {
            const shard = this.getOrAutomaticallyCreateShard(data.shardId);
            shard.status = Status.WaitingForGuilds;
            // @ts-expect-error: use original handling to handle ready check of d.js
            shard.onPacket(data.data);
        });
        this.manager.on(WebSocketShardEvents.Closed, (data: CustomCloseData) => {
            const shard = this.getOrAutomaticallyCreateShard(data.shardId);
            if (data.additional) {
                if (data.additional.recover !== undefined) {
                    shard.status = Status.Reconnecting;
                    return this.client.emit(ClientEvents.ShardReconnecting, data.shardId);
                }
                shard.status = Status.Idle;
                const event: CloseEvent = {
                    wasClean: true,
                    code: data.code,
                    reason: data.additional.reason || '',
                    target: ({} as any) // to mimic a close event cause we dont have an actual ws here
                };
                this.client.emit(ClientEvents.ShardDisconnect, event, data.shardId);
            }
        });
        this.manager.on(WebSocketShardEvents.Resumed, data => {
            const shard = this.getOrAutomaticallyCreateShard(data.shardId);
            shard.status = Status.Ready;
            // we can't know how many resumed events cause the wrapper doesn't show it
            this.client.emit(ClientEvents.ShardResume, shard!.id, 0);
        });
        this.manager.on(WebSocketShardEvents.HeartbeatComplete, data => {
            const shard = this.getOrAutomaticallyCreateShard(data.shardId);
            shard.ping = data.latency;
        });
        this.manager.on(WebSocketShardEvents.Dispatch, packet => {
            const shard = this.getOrAutomaticallyCreateShard(packet.shardId);
            this.client.emit(ClientEvents.Raw, packet.data, packet.shardId);
            // d.js has this kind of manager event firing for some reason that I don't know for now
            this.emit(packet.data.t, packet.data.d, packet.shardId);
            // @ts-expect-error: forward dispatch events to the shard for d.js to work
            shard.onPacket(packet.data);
        });
        this.manager.on(WebSocketShardEvents.Debug, data => this.client.emit(ClientEvents.Debug, `[WS => Shard ${data.shardId} => Worker] ${data.message}`));
        this.eventsAttached = true;
    }

    private async connect(): Promise<void> {
        this.manager.options.token = this.client.token!;
        const gateway = await this.manager.fetchGatewayInformation();
        const { total, remaining, max_concurrency } = gateway.session_start_limit;
        this.debug(`[Info] Fetched Gateway Information\n        URL: ${gateway.url}\n        Recommended Shards: ${gateway.shards}\nSession Limit Information\n        Total: ${total}\n        Remaining: ${remaining}\n        Concurrency: ${max_concurrency}`);
        if (this.client.options.shards === 'auto') {
            this.manager.options.shardCount = gateway.shards;
            this.debug(`[Info] Using Discord Recommended Shard count ${gateway.shards}`);
        } else {
            if (isNaN(this.client.options.shardCount!)) throw new Error('Shard Count must be a number if not sauto');
            if (!Array.isArray(this.client.options.shards)) throw new Error('Shards must be an array of number if not auto');
            this.manager.options.shardCount = this.client.options.shardCount!;
            this.manager.options.shardIds = this.client.options.shards as number[];
            this.debug(`[Info] Spawn settings\n        Shards: [ ${this.manager.options.shardIds.join(', ')} ]\n        Shard Count: ${this.manager.options.shardIds.length}\n        Total Shards: ${this.client.options.shardCount}`);
        }
        this.attachEventsToWebsocketManager();
        const strategy = new VanguardWorkerShardingStrategy(this.manager, this.workerOptions);
        this.manager.setStrategy(strategy);
        this.debug(`[Info] Using Vanguard worker shading strategy\n        Workers: ${this.workerOptions.shardsPerWorker}\n        File Dir: ${this.workerOptions.workerPath}\n        Using custom identify throttling: ${!!this.workerOptions.identifyThrottler}`);
        for (let i = 0; i < this.manager.options.shardCount; i++)
            this.getOrAutomaticallyCreateShard(i);
        await this.manager.connect();
    }

    public destroy(): void {
        // @ts-expect-error: need to access private property
        if (this.destroyed) return;
        // @ts-expect-error: need to access private property
        this.destroyed = true;
        // to avoid uncaught promise
        Promise
            .resolve(this.manager.destroy())
            .catch(error => this.client.emit(ClientEvents.Error, error));
    }

    private checkShardsReady(): void {
        if (this.status === Status.Ready || this.shards.some(shard => shard.status !== Status.Ready)) return;
        // @ts-expect-error: need to access private property
        this.triggerClientReady();
    }

    // @ts-expect-error: d.js marks this as private, even though it's used on another class internally
    protected debug(message: string, shard?: WebsocketShardProxy) {
        this.client.emit(ClientEvents.Debug, `[WS => ${shard ? `Shard ${shard.id} => Proxy` : 'Proxy'}] ${message}`);
    }
}
