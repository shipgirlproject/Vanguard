import { join } from 'node:path';
import {
    WebSocketShard,
    Collection,
    Client,
    Status,
    Events as ClientEvents,
    WebSocketManager as Legacy,
    WebSocketShardEvents as LegacyEvents,
    GatewayDispatchPayload
} from 'discord.js';
import {
    WebSocketShardEvents,
    WebSocketShardDestroyRecovery,
    WebSocketManager as Updated,
    OptionalWebSocketManagerOptions,
    RequiredWebSocketManagerOptions,
    CompressionMethod
} from '@discordjs/ws';
import { GatewayDispatchEvents, GatewayPresenceUpdateData } from 'discord-api-types/v10';
import { WebsocketShardProxy } from './WebsocketShardProxy';
import { VanguardWorkerShardingStrategy } from '../strategy/VanguardWorkerShardingStrategy';
import { OptionalVanguardWorkerOptions, VanguardIdentifyManager, VanguardOptions } from '../Vanguard';

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
}

export const beforeReadyWhitelist = [
    GatewayDispatchEvents.Ready,
    GatewayDispatchEvents.Resumed,
    GatewayDispatchEvents.GuildCreate,
    GatewayDispatchEvents.GuildDelete,
    GatewayDispatchEvents.GuildMembersChunk,
    GatewayDispatchEvents.GuildMemberAdd,
    GatewayDispatchEvents.GuildMemberRemove,
];

// @ts-expect-error: private properties modified
export class WebsocketProxy extends Legacy {
    public readonly manager: Updated;
    // @ts-expect-error: private properties modified
    public readonly shards: Collection<number, WebsocketShardProxy>;
    public readonly identifyManager: VanguardIdentifyManager|undefined;
    private readonly workerOptions: VanguardWorkerOptions;
    private readonly disableBeforeReadyPacketQueue: boolean;
    private eventsAttached: boolean;
    private destroyed: boolean;
    constructor(client: Client, vanguardOptions: VanguardOptions = {}) {
        super(client);
        this.manager = new Updated(this.createSharderOptions(vanguardOptions.sharderOptions));
        this.shards = new Collection();
        if (vanguardOptions.identifyManager)
            this.identifyManager = vanguardOptions.identifyManager;
        else
            this.identifyManager = undefined;
        this.workerOptions = this.createWorkerOptions(vanguardOptions.workerOptions);
        this.disableBeforeReadyPacketQueue = vanguardOptions.disableBeforeReadyPacketQueue ?? false;
        this.eventsAttached = false;
        this.destroyed = false;
    }

    private createSharderOptions(sharderOptions?: OptionalWebSocketManagerOptions): RequiredWebSocketManagerOptions&OptionalWebSocketManagerOptions {
        const largeThreshold = this.client.options.ws?.large_threshold || null;
        const version = this.client.options.ws?.version?.toString() || '10';
        const compression = this.client.options.ws?.compress ? CompressionMethod.ZlibStream : null;
        const requiredOptions = {
            token: this.client.token!,
            intents: this.client.options.intents.bitfield as unknown as number,
            rest: this.client.rest,
            initialPresence: this.client.options.presence || null as GatewayPresenceUpdateData|null,
            largeThreshold,
            version,
            compression
        };
        return { ...requiredOptions, ...sharderOptions } as RequiredWebSocketManagerOptions&OptionalWebSocketManagerOptions;
    }

    private createWorkerOptions(options: OptionalVanguardWorkerOptions|undefined): VanguardWorkerOptions {
        return {
            shardsPerWorker: options?.shardsPerWorker || 'all',
            workerPath: options?.workerPath || join(__dirname, '../worker/DefaultWorker.js')
        };
    }

    public ensureShard(id: number): WebsocketShardProxy {
        let shard = this.shards.get(id);
        if (!shard) {
            shard = new WebsocketShardProxy(this, id);
            this.shards.set(id, shard);
        }
        if (!shard.eventsAttached) {
            shard.on(LegacyEvents.AllReady, (unavailable: Set<string>|undefined) => shard!.onReady(unavailable));
            shard.eventsAttached = true;
        }
        return shard;
    }

    private attachEventsToWebsocketManager(): void {
        if (this.eventsAttached) return;
        this.manager.on(WebSocketShardEvents.Closed, (data: CustomCloseData) => {
            const shard = this.ensureShard(data.shardId);
            shard.onClose(data);
        });
        this.manager.on(WebSocketShardEvents.HeartbeatComplete, data => {
            const shard = this.ensureShard(data.shardId);
            shard.onHearbeat(data.latency);
        });
        this.manager.on(WebSocketShardEvents.Dispatch, packet => {
            this.client.emit(ClientEvents.Raw, packet.data, packet.shardId);
            const shard = this.ensureShard(packet.shardId);
            // d.js has this kind of manager event firing for some reason that I don't know for now
            this.emit(packet.data.t, packet.data.d, packet.shardId);
            shard.onDispatch(packet.data);
        });
        this.manager.on(WebSocketShardEvents.Debug, data => this.client.emit(ClientEvents.Debug, `[WS => Shard ${data.shardId} => Worker] ${data.message}`));
        this.eventsAttached = true;
    }

    private async connect(): Promise<void> {
        this.manager.options.token = this.client.token!;
        this.manager.options.rest = this.client.rest;
        const gateway = await this.manager.fetchGatewayInformation();
        const { total, remaining, max_concurrency } = gateway.session_start_limit;
        this.debug(`[Info] Fetched Gateway Information\n        URL: ${gateway.url}\n        Recommended Shards: ${gateway.shards}\nSession Limit Information\n        Total: ${total}\n        Remaining: ${remaining}\n        Concurrency: ${max_concurrency}`);
        if (this.client.options.shards === 'auto') {
            this.manager.options.shardCount = gateway.shards;
            this.manager.options.shardIds = [...Array(gateway.shards).keys()];
            this.debug(`[Info] Using Discord Recommended Shard count ${gateway.shards}`);
        } else {
            if (isNaN(this.client.options.shardCount!)) throw new Error('Shard Count must be a number if not auto');
            if (!Array.isArray(this.client.options.shards)) throw new Error('Shards must be an array of number if not auto');
            this.manager.options.shardCount = this.client.options.shardCount!;
            this.manager.options.shardIds = this.client.options.shards as number[];
            this.debug(`[Info] Spawn settings\n        Shards: [ ${this.manager.options.shardIds.join(', ')} ]\n        Shard Count: ${this.manager.options.shardIds.length}\n        Total Shards: ${this.client.options.shardCount}`);
        }
        this.attachEventsToWebsocketManager();
        const strategy = new VanguardWorkerShardingStrategy(this, this.manager, this.workerOptions);
        this.manager.setStrategy(strategy);
        this.debug(`[Info] Using Vanguard worker shading strategy\n        Workers: ${this.workerOptions.shardsPerWorker}\n        File Dir: ${this.workerOptions.workerPath}\n        Using custom identify throttling: ${!!this.identifyManager}`);
        for (const shardId of this.manager.options.shardIds) this.ensureShard(shardId);
        await this.manager.connect();
    }

    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        // to avoid uncaught promise
        Promise
            .resolve(this.manager.destroy())
            .catch(error => this.client.emit(ClientEvents.Error, error));
    }

    // @ts-expect-error: need to change the private function
    public handlePacket(packet: GatewayDispatchPayload, shard: WebsocketShardProxy): boolean {
        if (packet && this.status !== Status.Ready) {
            if (!beforeReadyWhitelist.includes(packet.t)) {
                if (!this.disableBeforeReadyPacketQueue) {
                    // @ts-expect-error: need to change the private function
                    this.packetQueue.push({ packet, shard });
                }
                return false;
            }
        }
        // @ts-expect-error: need to access private property
        return super.handlePacket(packet, (shard as unknown as WebSocketShard));
    }

    public checkShardsReady(): void {
        if (this.status === Status.Ready || this.shards.some(shard => shard.status !== Status.Ready)) return;
        // @ts-expect-error: need to access private property
        this.triggerClientReady();
    }

    // @ts-expect-error: d.js marks this as private, even though it's used on another class internally
    protected debug(message: string, shard?: WebsocketShardProxy): void {
        this.client.emit(ClientEvents.Debug, `[WS => ${shard ? `Shard ${shard.id} => Proxy` : 'Proxy'}] ${message}`);
    }
}
