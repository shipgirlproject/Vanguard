import { GatewayDispatchEvents, GatewayDispatchPayload, GatewaySendPayload } from 'discord-api-types/v10';
import { WebSocketShard, WebSocketShardEvents, Status, CloseEvent, Events } from 'discord.js';
import { WebsocketProxy, CustomCloseData } from './WebsocketProxy';

// @ts-expect-error: private properties modified
export class WebsocketShardProxy extends WebSocketShard {
    public eventsAttached: boolean;
    // @ts-expect-error: private properties modified
    public manager: WebsocketProxy;
    private sequence: number;
    private closeSequence: number;
    constructor(manager: WebsocketProxy, id: number) {
        super(manager as any, id);
        // do not change once it's set to true
        this.eventsAttached = false;
        this.sequence = -1;
        this.closeSequence = 0;
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

    // @ts-expect-error: private properties modified
    public onClose(data: CustomCloseData): void {
        this.status = Status.Idle;
        if (this.sequence !== -1)
            this.closeSequence = Number(this.sequence);
        this.sequence = -1;
        if (!data.additional) return;
        if (data.additional.recover !== undefined) {
            this.status = Status.Reconnecting;
            this.manager.client.emit(Events.ShardReconnecting, data.shardId);
            return;
        }
        const event: CloseEvent = {
            wasClean: true,
            code: data.code,
            reason: data.additional.reason || '',
            target: {} as any
        };
        this.manager.client.emit(Events.ShardDisconnect, event, data.shardId);
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
            // @ts-expect-error: Private properties modified
            this.expectedGuilds = new Set(packet.d.guilds.map(d => d.id));
            this.status = Status.WaitingForGuilds;
            // @ts-expect-error: Private properties modified
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
            // @ts-expect-error: private properties modified
            this.expectedGuilds.delete(packet.d.id);
            // @ts-expect-error: private properties modified
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
