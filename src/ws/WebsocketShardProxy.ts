import { EventEmitter } from 'events';
import { GatewayCloseCodes, GatewayIntentBits, GatewayDispatchEvents, GatewayDispatchPayload, GatewaySendPayload } from 'discord-api-types/v10';
import { CloseCodes, SessionInfo } from '@discordjs/ws';
import { WebSocketShardEvents, Status, Events } from 'discord.js';
import { WebsocketProxy } from './WebsocketProxy';

const UNRESUMABLE_CLOSE_CODES = [
    CloseCodes.Normal,
    GatewayCloseCodes.AlreadyAuthenticated,
    GatewayCloseCodes.InvalidSeq,
];

export class WebsocketShardProxy extends EventEmitter {
    public manager: WebsocketProxy;
    public id: number;
    public status: Status;
    public sequence: number;
    public closeSequence: number;
    public ping: number;
    public lastPingTimestamp: number;
    public expectedGuilds: Set<string>;
    public sessionInfo: SessionInfo|null;
    public eventsAttached: boolean;
    private readyTimeout: NodeJS.Timeout|null;
    constructor(manager: WebsocketProxy, id: number) {
        super();
        this.manager = manager;
        this.id = id;
        this.status = Status.Idle;
        this.sequence = -1;
        this.closeSequence = 0;
        this.ping = -1;
        this.lastPingTimestamp = -1;
        this.expectedGuilds = new Set();
        this.sessionInfo = null;
        this.eventsAttached = false;
        this.readyTimeout = null;
    }

    public send(data: GatewaySendPayload): void {
        if (this.status === Status.Idle) return;
        const { manager } = this.manager;
        Promise
            .resolve(manager.send(this.id, data))
            .catch(error => this.manager.client.emit(Events.ShardError, error, this.id));
    }

    public onReady(unavailable: Set<string>|undefined): void {
        this.status = Status.Ready;
        this.manager.client.emit(Events.ShardReady, this.id, unavailable);
        this.manager.checkShardsReady();
    }

    public onClose(data: { code: number, shardId: number }): void {
        if (this.sequence !== -1)
            this.closeSequence = Number(this.sequence);
        this.sequence = -1;
        this.emit(WebSocketShardEvents.Close, data.code);
        // only emit event shard disconnect when manager is destroyed (discord.js ws reconnects on close code 1000 unless destroyed is called)
        if (this.manager.destroyed && UNRESUMABLE_CLOSE_CODES.includes(data.code)) {
            this.status = Status.Disconnected;
            this.debug(`[Proxy Disconnect] Close Code: ${data.code}`);
            this.manager.client.emit(Events.ShardDisconnect, (data as any), data.shardId);
            return;
        }
        this.status = Status.Reconnecting;
        this.debug(`[Proxy Reconnecting] Close Code: ${data.code}`);
        this.manager.client.emit(Events.ShardReconnecting, data.shardId);
    }

    public onHearbeat(latency: number): void {
        this.ping = latency;
    }

    // ready, resumed & dispatch event
    public onDispatch(packet: GatewayDispatchPayload): void {
        if (!packet) {
            this.debug(`Received broken packet: '${packet}'.`);
            return;
        }
        switch(packet.t) {
        case GatewayDispatchEvents.Ready: {
            this.expectedGuilds = new Set(packet.d.guilds.map(d => d.id));
            this.status = Status.WaitingForGuilds;
            this.debug(`[Proxy READY] Waiting for ${this.expectedGuilds.size} guilds`);
            this.emit(WebSocketShardEvents.Ready);
            break;
        }
        case GatewayDispatchEvents.Resumed: {
            this.status = Status.Ready;
            const replayed = packet.s - this.closeSequence;
            this.debug(`[Proxy RESUMED] Replayed ${replayed}`);
            this.emit(WebSocketShardEvents.Resumed);
            break;
        }
        }
        if (packet.s > this.sequence) this.sequence = packet.s;
        (this.manager as unknown as WebsocketProxy).handlePacket(packet, this);
        if (this.status === Status.WaitingForGuilds && packet.t === GatewayDispatchEvents.GuildCreate) {
            this.expectedGuilds.delete(packet.d.id);
            this.checkReady();
        }
    }

    public onError(error: Error) {
        this.manager.client.emit(Events.ShardError, error, this.id);
    }

    protected debug(message: string) {
        this.manager.debug(message, this);
    }

    protected checkReady() {
        if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
        }
        if (!this.expectedGuilds.size) {
            this.debug('Shard received all its guilds. Marking as fully ready.');
            this.status = Status.Ready;
            this.emit(WebSocketShardEvents.AllReady);
            return;
        }
        const hasGuildsIntent = this.manager.client.options.intents.has(GatewayIntentBits.Guilds);
        const { waitGuildTimeout } = this.manager.client.options;
        this.readyTimeout = setTimeout(
            () => {
                this.debug(
                    `Shard ${hasGuildsIntent ? 'did' : 'will'} not receive any more guild packets` +
                    `${hasGuildsIntent ? ` in ${waitGuildTimeout} ms` : ''}.\nUnavailable guild count: ${
                        this.expectedGuilds.size
                    }`,
                );

                this.readyTimeout = null;
                this.status = Status.Ready;

                this.emit(WebSocketShardEvents.AllReady, this.expectedGuilds);
            },
            hasGuildsIntent ? waitGuildTimeout : 0,
        ).unref();
    }
}
