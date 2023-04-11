import { GatewayCloseCodes, GatewayDispatchEvents, GatewayDispatchPayload, GatewaySendPayload } from 'discord-api-types/v10';
import { CloseCodes } from '@discordjs/ws';
import { WebSocketShard, WebSocketShardEvents, Status, CloseEvent, Events } from 'discord.js';
import { WebsocketProxy } from './WebsocketProxy';

const UNRESUMABLE_CLOSE_CODES = [
    CloseCodes.Normal,
    GatewayCloseCodes.AlreadyAuthenticated,
    GatewayCloseCodes.InvalidSeq,
];

// @ts-expect-error: private properties modified
export class WebsocketShardProxy extends WebSocketShard {
    public eventsAttached: boolean;
    // @ts-expect-error: private properties modified
    public manager: WebsocketProxy;
    private sequence: number;
    private closeSequence: number;
    private expectedGuilds: Set<string>;
    constructor(manager: WebsocketProxy, id: number) {
        super(manager as any, id);
        // do not change once it's set to true
        this.eventsAttached = false;
        this.sequence = -1;
        this.closeSequence = 0;
        this.expectedGuilds = new Set();
        // might just not make this extend and make it it's own class
        // @ts-expect-error: delete-able props
        delete this.sessionId;
        // @ts-expect-error: delete-able props
        delete this.resumeURL;
        // @ts-expect-error: delete-able props
        delete this.lastPingTimestamp;
        // @ts-expect-error: delete-able props
        delete this.lastHeartbeatAcked;
        // @ts-expect-error: delete-able props
        delete this.closeEmitted;
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

    // @ts-expect-error: custom on close method
    public onClose(data: { code: number, shardId: number }): void {
        if (this.sequence !== -1)
            this.closeSequence = Number(this.sequence);
        this.sequence = -1;
        this.emit(WebSocketShardEvents.Close, data.code);
        if (UNRESUMABLE_CLOSE_CODES.includes(data.code)) {
            this.status = Status.Disconnected;
            // @ts-expect-error: emit close code only instead
            this.manager.client.emit(Events.ShardDisconnect, data.code, data.shardId);
            return;
        }
        this.status = Status.Reconnecting;
        // @ts-expect-error: add close code instead
        this.manager.client.emit(Events.ShardReconnecting, data.code, data.shardId);
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
            // @ts-expect-error: access private function
            this.checkReady();
        }
    }

    public onError(error: Error) {
        this.manager.client.emit(Events.ShardError, error, this.id);
    }

    protected debug(message: string) {
        // @ts-expect-error: private properties modified
        this.manager.debug(message, this);
    }

    // cleaned functions to avoid conflicts, tldr they should do nothing
    public async connect(): Promise<void> {}
    private onPacket(): void {}
    private onOpen(): void {}
    private onMessage(): void {}
    private processQueue(): void {}
    private setHelloTimeout(): void {}
    private setWsCloseTimeout(): void {}
    private setHeartbeatTimer(): void {}
    private sendHeartbeat(): void {}
    private ackHeartbeat(): void {}
    private identify(): void {}
    private identifyNew(): void {}
    private identifyResume(): void {}
    private destroy(): void {}
    private emitClose(): void {}
    private _send(): void {}
    private _cleanupConnection(): void {}
    private _emitDestroyed(): void {}
}
