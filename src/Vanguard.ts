import { Client, ClientOptions } from 'discord.js';
import { OptionalWebSocketManagerOptions } from '@discordjs/ws';
import { WebsocketProxy } from './ws/WebsocketProxy';

export interface VanguardWorkerOptions {
	shardsPerWorker?: number | 'all',
	workerPath?: string;
}

export class Vanguard extends Client {
    // @ts-expect-error: private properties modified
    public readonly ws: WebsocketProxy;
    constructor(options: ClientOptions, sharderOptions?: OptionalWebSocketManagerOptions, workerOptions?: VanguardWorkerOptions) {
        super(options);
        // @ts-expect-error: private properties modified
        this.ws = new WebsocketProxy(this, sharderOptions, workerOptions);
    }
}
