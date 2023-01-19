import { Client, ClientOptions } from 'discord.js';
import { OptionalWebSocketManagerOptions, WebSocketManager, IdentifyThrottler } from '@discordjs/ws';
import { WebsocketProxy } from './ws/WebsocketProxy';

export type Constructor<T> = new (...args: any[]) => T;

export abstract class VanguardIdentifyThrottler extends IdentifyThrottler {
    private readonly args: unknown[];
    constructor(manager: WebSocketManager, args: unknown[]) {
        super(manager);
        this.args = args;
    }
    abstract waitForIdentify(): Promise<void>;
    abstract waitForIdentify(shardId: number): Promise<void>;
}

export interface OptionalVanguardWorkerOptions {
	shardsPerWorker?: number | 'all',
	workerPath?: string;
    identifyThrottler?: {
        class: Constructor<VanguardIdentifyThrottler>,
        args: unknown[]
    }
}

export class Vanguard extends Client {
    // @ts-expect-error: private properties modified
    public readonly ws: WebsocketProxy;
    constructor(options: ClientOptions, sharderOptions?: OptionalWebSocketManagerOptions, workerOptions?: OptionalVanguardWorkerOptions) {
        super(options);
        // @ts-expect-error: private properties modified
        this.ws = new WebsocketProxy(this, sharderOptions, workerOptions);
    }
}
