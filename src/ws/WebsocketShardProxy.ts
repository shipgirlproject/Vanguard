import { GatewaySendPayload } from 'discord-api-types/v10';
import { WebSocketShard, Status, Events } from 'discord.js';
import { WebsocketProxy } from './WebsocketProxy';

// @ts-expect-error: Private properties modified
export class WebsocketShardProxy extends WebSocketShard {
    public eventsAttached: boolean;
    constructor(manager: WebsocketProxy, id: number) {
        // @ts-expect-error: Private properties modified
        super(manager, id);
        // do not change once it's set to true
        this.eventsAttached = false;
    }

    public send(data: GatewaySendPayload): void {
        const proxy = this.manager as unknown as WebsocketProxy;
        if (this.status === Status.Idle) return;
        Promise
            .resolve(proxy.manager.send(this.id, data))
            .catch(error => proxy.client.emit(Events.ShardError, error, this.id));
    }

    // cleaned functions to avoid conflicts, tldr they should do nothing
    public connect(): Promise<void> {
        return Promise.resolve();
    }
    private onOpen(): void {}
    private onMessage(): void {}
    private onError(): void {}
    private onClose(): void {}
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
