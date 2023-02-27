import { once } from 'events';
import { setTimeout as sleep } from 'node:timers/promises';
import { inflate } from 'node:zlib';
import { GatewayReceivePayload, GatewaySendPayload } from 'discord-api-types/v10';
import {
    getInitialSendRateLimitState,
    WebSocketShard,
    WebSocketShardStatus,
    WebSocketShardEvents,
    ImportantGatewayOpcodes,
    IContextFetchingStrategy,
    WebSocketShardDestroyOptions,
    WebSocketShardDestroyRecovery,
    SendRateLimitState
} from '@discordjs/ws';
import { lazy } from '@discordjs/util';
import { AsyncQueue } from '@sapphire/async-queue';
import type { Inflate } from 'zlib-sync';

const getZlibSync = lazy(async () => import('zlib-sync').then((mod) => mod.default).catch(() => null));

export enum Encoding {
    JSON = 'json',
    ERLPACK = 'etf'
}

export interface Erlpack {
    pack(data: unknown): Buffer;
    unpack(data: Buffer): unknown;
}

// @ts-expect-error: unpack has different signature, mistyped on d.js types file
export class WebsocketShard extends WebSocketShard {
    private useIdentifyCompress: boolean;
    private inflate: Inflate | null;
    private erlpack: Erlpack|null;
    private sendRateLimitState: SendRateLimitState;
    private readonly textDecoder: TextDecoder;
    private readonly sendQueue: AsyncQueue;
    constructor(strategy: IContextFetchingStrategy, id: number) {
        super(strategy, id);
        this.useIdentifyCompress = false;
        this.inflate = null;
        this.erlpack = null;
        this.sendRateLimitState = getInitialSendRateLimitState();
        this.textDecoder = new TextDecoder();
        this.sendQueue = new AsyncQueue();
    }

    private get encoding(): Encoding {
        // @ts-expect-error: need to access private property
        return this.strategy.options.encoding as Encoding;
    }

    private set encoding(type: Encoding) {
        // @ts-expect-error: need to access private property
        (this.strategy.options.encoding as Encoding) = type;
    }

    public async connect(): Promise<void> {
        if (this.encoding === Encoding.ERLPACK) {
            try {
                // if erlpack is still not defined and encoding is set to erlpack
                if (!this.erlpack) {
                    this.erlpack = await import('erlpack');
                    this.debug([
                        'Erlpack loaded!',
                        `Will be using Erlpack encoding / decoding`
                    ]);
                }
            } catch (error: unknown) {
                this.debug([
                    'Erlpack failed to load',
                    `Error Message: ${(error as Error).toString()}`,
                    'Falling back to JSON encoding / decoding'
                ]);
                this.encoding = Encoding.JSON;
            }
        }
        await super.connect();
    }

    public destroy(options: WebSocketShardDestroyOptions = {}): Promise<void> {
        // needed to do some hacky ts (why did I even make this on ts) for d.js
        const data = {
            code: options.code || 1000,
            additional: {
                recover: options.recover,
                reason: options.reason
            }
        } as { code: number };
        this.emit(WebSocketShardEvents.Closed, data);
        return super.destroy(options);
    }

    private decodeMessage(data: Uint8Array|Buffer|string): GatewayReceivePayload | null {
        if (this.encoding === Encoding.ERLPACK) {
            return this.erlpack!.unpack(Buffer.from(data)) as GatewayReceivePayload;
        }
        const text = typeof data === 'string' ? data : this.textDecoder.decode(data);
        return JSON.parse(text) as GatewayReceivePayload;
    }

    private packMessage(data: unknown): String|Buffer {
        if (this.encoding === Encoding.ERLPACK) {
            return this.erlpack!.pack(data);
        }
        return JSON.stringify(data);
    }

    private async unpackMessage(data: ArrayBuffer | Buffer, isBinary: boolean): Promise<GatewayReceivePayload | null> {
        const decompressable = new Uint8Array(data);
        // Deal with no compression
        if (!isBinary || this.encoding === Encoding.ERLPACK && (!this.useIdentifyCompress && !this.inflate)) {
            return this.decodeMessage(decompressable);
        }
        if (this.useIdentifyCompress) {
            return new Promise((resolve, reject) => {
                inflate(decompressable, { chunkSize: 65_535 }, (err, result) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(this.decodeMessage(result));
                });
            });
        }
        if (this.inflate) {
            const l = decompressable.length;
            const flush =
				l >= 4 &&
				decompressable[l - 4] === 0x00 &&
				decompressable[l - 3] === 0x00 &&
				decompressable[l - 2] === 0xff &&
				decompressable[l - 1] === 0xff;
            const zlib = (await getZlibSync())!;
            this.inflate.push(Buffer.from(decompressable), flush ? zlib.Z_SYNC_FLUSH : zlib.Z_NO_FLUSH);
            if (this.inflate.err) {
                this.emit(WebSocketShardEvents.Error, {
                    error: new Error(`${this.inflate.err}${this.inflate.msg ? `: ${this.inflate.msg}` : ''}`),
                });
            }
            if (!flush) return null;
            const { result } = this.inflate;
            if (!result) return null;
            return this.decodeMessage(result) as GatewayReceivePayload;
        }
        this.debug([
            'Received a message we were unable to decompress',
            `isBinary: ${isBinary.toString()}`,
            `useIdentifyCompress: ${this.useIdentifyCompress.toString()}`,
            `inflate: ${Boolean(this.inflate).toString()}`,
        ]);
        return null;
    }

    public async send(payload: GatewaySendPayload): Promise<void> {
        // @ts-expect-error: need to access private property
        if (!this.connection) {
            throw new Error('WebSocketShard wasn\'t connected');
        }
        if (this.status !== WebSocketShardStatus.Ready && !ImportantGatewayOpcodes.has(payload.op)) {
            this.debug(['Tried to send a non-crucial payload before the shard was ready, waiting']);
            await once(this, WebSocketShardEvents.Ready);
        }
        await this.sendQueue.wait();
        if (--this.sendRateLimitState.remaining <= 0) {
            const now = Date.now();
            if (this.sendRateLimitState.resetAt > now) {
                const sleepFor = this.sendRateLimitState.resetAt - now;
                this.debug([`Was about to hit the send rate limit, sleeping for ${sleepFor}ms`]);
                const controller = new AbortController();
                // Sleep for the remaining time, but if the connection closes in the meantime, we shouldn't wait the remainder to avoid blocking the new conn
                const interrupted = await Promise.race([
                    sleep(sleepFor).then(() => false),
                    once(this, WebSocketShardEvents.Closed, { signal: controller.signal }).then(() => true),
                ]);
                if (interrupted) {
                    this.debug(['Connection closed while waiting for the send rate limit to reset, re-queueing payload']);
                    this.sendQueue.shift();
                    return this.send(payload);
                }
                // This is so the listener from the `once` call is removed
                controller.abort();
            }
            this.sendRateLimitState = getInitialSendRateLimitState();
        }
        this.sendQueue.shift();
        // since I ts expect error the connection below, it's better to put this here for possible errors
        const message = this.packMessage(payload);
        // @ts-expect-error: need to access private property
        this.connection.send(message);
    }

    private debug(messages: [string, ...string[]]): void {
        // @ts-expect-error: so I don't need to do ts-expect-error on every debug messages here
        return super.debug(messages);
    }
}
