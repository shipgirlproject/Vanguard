import {
    Client,
    Collection,
    Events as ClientEvents,
    GatewayDispatchPayload,
    Status,
    WebSocketShard,
    WebSocketManager as LegacyManager,
    WebSocketShardEvents as LegacyEvents
} from 'discord.js';
import {
    OptionalWebSocketManagerOptions,
    RequiredWebSocketManagerOptions,
    SessionInfo,
    WebSocketManager,
    WebSocketShardEvents
} from '@discordjs/ws';
import { EventEmitter } from 'events';
import { GatewayDispatchEvents, GatewayPresenceUpdateData, GatewaySendPayload } from 'discord-api-types/v10';
import { WebsocketShardProxy } from './WebsocketShardProxy';
import { VanguardOptions } from '../Vanguard';

export const beforeReadyWhitelist = [
    GatewayDispatchEvents.Ready,
    GatewayDispatchEvents.Resumed,
    GatewayDispatchEvents.GuildCreate,
    GatewayDispatchEvents.GuildDelete,
    GatewayDispatchEvents.GuildMembersChunk,
    GatewayDispatchEvents.GuildMemberAdd,
    GatewayDispatchEvents.GuildMemberRemove,
];

export class WebsocketProxy extends EventEmitter {
    public readonly client: Client;
    public readonly manager: WebSocketManager;
    public readonly shards: Collection<number, WebsocketShardProxy>;
    public readonly disableBeforeReadyPacketQueue: boolean;
    public gateway: string;
    public destroyed: boolean;
    public status: Status;
    private packetQueue: unknown[];
    private eventsAttached: boolean;
    private readonly legacyHandler: (packet?: unknown, shard?: WebSocketShard) => unknown;
    constructor(client: Client, vanguardOptions: VanguardOptions = {}) {
        super();
        this.client = client;
        this.manager = new WebSocketManager(this.createSharderOptions(vanguardOptions));
        this.shards = new Collection();
        this.disableBeforeReadyPacketQueue = vanguardOptions.disableBeforeReadyPacketQueue ?? false;
        this.gateway = '';
        this.destroyed = false;
        this.status = Status.Idle;
        this.packetQueue = [];
        this.eventsAttached = false;
        // @ts-expect-error
        this.legacyHandler = (new LegacyManager(client)).handlePacket;
    }

    private createSharderOptions(options: VanguardOptions): RequiredWebSocketManagerOptions&OptionalWebSocketManagerOptions {
        const { sharderOptions } = options;
        const requiredOptions = {
            token: this.client.token!,
            intents: this.client.options.intents.bitfield as unknown as number,
            rest: this.client.rest,
            initialPresence: this.client.options.presence || null as GatewayPresenceUpdateData|null,
            retrieveSessionInfo: (shardId: number) => this.ensureShard(shardId).sessionInfo,
            updateSessionInfo: (shardId: number, sessionInfo: SessionInfo) => this.ensureShard(shardId).sessionInfo = sessionInfo
        };
        return { ...requiredOptions, ...sharderOptions } as RequiredWebSocketManagerOptions&OptionalWebSocketManagerOptions;
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
        this.manager.on(WebSocketShardEvents.Closed, data => {
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
        this.manager.on(WebSocketShardEvents.Error, data => {
            const shard = this.ensureShard(data.shardId);
            shard.onError(data.error);
        });
        this.manager.on(WebSocketShardEvents.Debug, data => this.client.emit(ClientEvents.Debug, `[WS => Shard ${data.shardId} => Worker] ${data.message}`));
        this.eventsAttached = true;
    }

    private async connect(): Promise<void> {
        if (this.destroyed) return;
        this.manager.options.token = this.client.token!;
        this.manager.options.rest = this.client.rest;
        const gateway = await this.manager.fetchGatewayInformation();
        const { total, remaining, max_concurrency } = gateway.session_start_limit;
        this.gateway = gateway.url;
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
        for (const shardId of this.manager.options.shardIds) this.ensureShard(shardId);
        await this.manager.connect();
    }

    public broadcast(data: GatewaySendPayload): void {
        for (const shard of this.shards.values()) shard.send(data);
    }

    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.status = Status.Disconnected;
        // to avoid uncaught promise
        Promise
            .resolve(this.manager.destroy())
            .catch(error => this.client.emit(ClientEvents.Error, error));
    }

    public handlePacket(packet?: GatewayDispatchPayload, shard?: WebsocketShardProxy): boolean {
        if (packet && this.status !== Status.Ready) {
            // packet.t somehow errors here for some reason
            if (!beforeReadyWhitelist.includes(packet.t as any)) {
                if (!this.disableBeforeReadyPacketQueue) {
                    this.packetQueue.push({ packet, shard });
                }
                return false;
            }
        }
        this.legacyHandler(packet, shard as unknown as WebSocketShard);
        return true;
    }

    public checkShardsReady(): void {
        if (this.status === Status.Ready || this.shards.some(shard => shard.status !== Status.Ready)) return;
        this.triggerClientReady();
    }

    public debug(message: string, shard?: WebsocketShardProxy): void {
        this.client.emit(ClientEvents.Debug, `[WS => ${shard ? `Shard ${shard.id} => Proxy` : 'Proxy'}] ${message}`);
    }

    protected triggerClientReady(): void {
        this.status = Status.Ready;
        this.client.readyTimestamp = Date.now();
        this.client.emit(ClientEvents.ClientReady, this.client as unknown as Client<true>);
        this.handlePacket();
    }
}
