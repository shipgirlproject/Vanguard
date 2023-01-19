import { once } from 'events';
import { setTimeout as sleep } from 'node:timers/promises';
import { GatewayReceivePayload, GatewaySendPayload } from 'discord-api-types/v10';
import {
    getInitialSendRateLimitState,
    WebSocketShard,
    WebSocketShardStatus,
    WebSocketShardEvents,
    ImportantGatewayOpcodes,
    IContextFetchingStrategy,
    WebSocketShardDestroyOptions
} from '@discordjs/ws';
import { lazy } from '@discordjs/util';

const getZlibSync = lazy(async () => import('zlib-sync').then((mod) => mod.default).catch(() => null));

export enum Encoding {
    JSON = "json",
    ERLPACK = "etf"
}

export interface Erlpack {
    pack(data: unknown): Buffer;
    unpack(data: Buffer): unknown;
}

// @ts-expect-error: unpack has different signature, mistyped on d.js types file
export class WebsocketShard extends WebSocketShard {
    private erlpack: Erlpack|null;
    constructor(strategy: IContextFetchingStrategy, id: number) {
        super(strategy, id);
        this.erlpack = null;
    }

    private get encoding(): Encoding {
        // @ts-expect-error: need to access private property
        return this.strategy.options.encoding as Encoding;
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
                // @ts-expect-error: need to access private property
                (this.strategy.options.encoding as Encoding) = Encoding.JSON;
            }
        }
        return await super.connect();
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

    private decodeMessage(data: Uint8Array|string): GatewayReceivePayload | null {
        if (this.encoding === Encoding.ERLPACK) {
            return this.erlpack!.unpack(Buffer.from(data)) as GatewayReceivePayload;
        }
        // @ts-expect-error: need to access private property
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
        if (!isBinary) {
            return this.decodeMessage(decompressable);
        }
        // Deal with no compression but encoded with erlpack
        if (this.encoding === Encoding.ERLPACK) {
            return this.decodeMessage(decompressable);
        }
        // @ts-expect-error: need to access private property
        if (this.useIdentifyCompress) {
            return new Promise((resolve, reject) => {
                // @ts-expect-error: need to access private property
                this.inflate(decompressable, { chunkSize: 65_535 }, (err: unknown, result: unknown) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(this.decodeMessage(result as Uint8Array));
                });
            });
        }
        // @ts-expect-error: need to access private property
        if (this.inflate) {
            const l = decompressable.length;
            const flush =
				l >= 4 &&
				decompressable[l - 4] === 0x00 &&
				decompressable[l - 3] === 0x00 &&
				decompressable[l - 2] === 0xff &&
				decompressable[l - 1] === 0xff;

            const zlib = (await getZlibSync())!;
            // @ts-expect-error: need to access private property
            this.inflate.push(Buffer.from(decompressable), flush ? zlib.Z_SYNC_FLUSH : zlib.Z_NO_FLUSH);
            // @ts-expect-error: need to access private property
            if (this.inflate.err) {
                // @ts-expect-error: need to access private property
                this.emit('error', `${this.inflate.err}${this.inflate.msg ? `: ${this.inflate.msg}` : ''}`);
            }
            if (!flush) {
                return null;
            }
            // @ts-expect-error: need to access private property
            const { result } = this.inflate;
            if (!result) {
                return null;
            }
            return this.decodeMessage(result) as GatewayReceivePayload;
        }
        this.debug([
            'Received a message we were unable to decompress',
            `isBinary: ${isBinary.toString()}`,
            // @ts-expect-error: need to access private property
            `useIdentifyCompress: ${this.useIdentifyCompress.toString()}`,
            // @ts-expect-error: need to access private property
            `inflate: ${Boolean(this.inflate).toString()}`,
        ]);
        return null;
    }

    public async send(payload: GatewaySendPayload): Promise<void> {
        // @ts-expect-error: need to access private property
        if (!this.connection) {
            throw new Error("WebSocketShard wasn't connected");
        }
        if (this.status !== WebSocketShardStatus.Ready && !ImportantGatewayOpcodes.has(payload.op)) {
            this.debug(['Tried to send a non-crucial payload before the shard was ready, waiting']);
            await once(this, WebSocketShardEvents.Ready);
        }
        // @ts-expect-error: need to access private property
        await this.sendQueue.wait();
        // @ts-expect-error: need to access private property
        if (--this.sendRateLimitState.remaining <= 0) {
            const now = Date.now();
            // @ts-expect-error: need to access private property
            if (this.sendRateLimitState.resetAt > now) {
                // @ts-expect-error: need to access private property
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
                    // @ts-expect-error: need to access private property
                    this.sendQueue.shift();
                    return this.send(payload);
                }
                // This is so the listener from the `once` call is removed
                controller.abort();
            }
            // @ts-expect-error: need to access private property
            this.sendRateLimitState = getInitialSendRateLimitState();
        }
        // @ts-expect-error: need to access private property
        this.sendQueue.shift();
        // @ts-expect-error: need to access private property
        this.connection.send(this.packMessage(payload));
    }

    // so I don't need to do ts-expect-error on every debug messages here
    private debug(messages: [string, ...string[]]): void {
        // @ts-expect-error: need to access private property
        return super.debug(messages);
    }
}
