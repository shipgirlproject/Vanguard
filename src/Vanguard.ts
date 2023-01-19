import { Client, ClientOptions } from 'discord.js';
import { OptionalWebSocketManagerOptions } from '@discordjs/ws';
import { WebsocketProxy } from './ws/WebsocketProxy';

export type Constructor<T> = new (...args: any[]) => T;

export interface OptionalVanguardWorkerOptions {
	shardsPerWorker?: number | 'all',
	workerPath?: string;
}

export interface VanguardOptions {
    workerOptions?: OptionalVanguardWorkerOptions,
    sharderOptions?: OptionalWebSocketManagerOptions,
    identifyManager?: Constructor<VanguardIdentifyManager>
    disableBeforeReadyPacketQueue?: boolean;
}

export abstract class VanguardIdentifyManager {
    protected readonly proxy: WebsocketProxy;
    constructor(proxy: WebsocketProxy) {
        this.proxy = proxy;
    }
    abstract waitForIdentify(shardId?: number): Promise<void>;
    abstract additionalSetup(data?: unknown): Promise<void>
    abstract additionalSetup(data?: unknown): void
}

export class Vanguard extends Client {
    // @ts-expect-error: private properties modified
    public readonly ws: WebsocketProxy;
    constructor(options: ClientOptions, vanguardOptions: VanguardOptions = {}) {
        super(options);
        // @ts-expect-error: private properties modified
        this.ws = new WebsocketProxy(this, vanguardOptions);
    }
}
