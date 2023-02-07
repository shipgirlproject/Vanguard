import { OptionalWebSocketManagerOptions } from '@discordjs/ws';

export type Constructor<T> = new (...args: any[]) => T;

export interface OptionalVanguardWorkerOptions {
	shardsPerWorker?: number | 'all',
	workerPath?: string;
}

export interface VanguardOptions {
    workerOptions?: OptionalVanguardWorkerOptions,
    sharderOptions?: OptionalWebSocketManagerOptions,
    identifyManager?: VanguardIdentifyManager
    disableBeforeReadyPacketQueue?: boolean;
}

export abstract class VanguardIdentifyManager {
    protected readonly context: unknown;
    constructor(context: unknown) {
        this.context = context;
    }
    abstract waitForIdentify(shardId?: number): Promise<void>;
}
