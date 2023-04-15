import { OptionalWebSocketManagerOptions, WorkerShardingStrategyOptions } from '@discordjs/ws';

export type Constructor<T> = new (...args: any[]) => T;

export interface OptionalVanguardWorkerOptions {
	shardsPerWorker?: number | 'all',
	workerPath?: string;
}

export interface VanguardOptions {
    workerOptions?: WorkerShardingStrategyOptions,
    sharderOptions?: OptionalWebSocketManagerOptions,
    disableBeforeReadyPacketQueue?: boolean;
}
