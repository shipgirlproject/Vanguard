import { OptionalWebSocketManagerOptions } from '@discordjs/ws';

export type Constructor<T> = new (...args: any[]) => T;

export interface OptionalVanguardWorkerOptions {
	shardsPerWorker?: number | 'all',
	workerPath?: string;
}

export interface VanguardOptions {
    workerOptions?: OptionalVanguardWorkerOptions,
    sharderOptions?: OptionalWebSocketManagerOptions,
    disableBeforeReadyPacketQueue?: boolean;
}
