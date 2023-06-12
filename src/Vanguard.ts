import { OptionalWebSocketManagerOptions, WorkerShardingStrategyOptions } from '@discordjs/ws';
import { Client } from 'discord.js';
import { WebsocketProxy } from './ws/WebsocketProxy.js';

export interface VanguardOptions {
    workerOptions?: WorkerShardingStrategyOptions,
    sharderOptions?: OptionalWebSocketManagerOptions,
    disableBeforeReadyPacketQueue?: boolean;
}

export function Inject(client: typeof Client, options: VanguardOptions): void {
    // @ts-expect-error
    client.ws = new WebsocketProxy(client, options);
}
