import { Logger, StateAdapter, Lock } from 'chat';
import { RedisClientType } from 'redis';

interface RedisStateAdapterOptions {
    /** Key prefix for all Redis keys (default: "chat-sdk") */
    keyPrefix?: string;
    /** Logger instance for error reporting */
    logger: Logger;
    /** Redis connection URL (e.g., redis://localhost:6379) */
    url: string;
}
/**
 * Redis state adapter for production use.
 *
 * Provides persistent subscriptions and distributed locking
 * across multiple server instances.
 */
declare class RedisStateAdapter implements StateAdapter {
    private readonly client;
    private readonly keyPrefix;
    private readonly logger;
    private connected;
    private connectPromise;
    constructor(options: RedisStateAdapterOptions);
    private key;
    private subscriptionsSetKey;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    subscribe(threadId: string): Promise<void>;
    unsubscribe(threadId: string): Promise<void>;
    isSubscribed(threadId: string): Promise<boolean>;
    acquireLock(threadId: string, ttlMs: number): Promise<Lock | null>;
    forceReleaseLock(threadId: string): Promise<void>;
    releaseLock(lock: Lock): Promise<void>;
    extendLock(lock: Lock, ttlMs: number): Promise<boolean>;
    get<T = unknown>(key: string): Promise<T | null>;
    set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
    setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
    delete(key: string): Promise<void>;
    appendToList(key: string, value: unknown, options?: {
        maxLength?: number;
        ttlMs?: number;
    }): Promise<void>;
    getList<T = unknown>(key: string): Promise<T[]>;
    private ensureConnected;
    /**
     * Get the underlying Redis client for advanced usage.
     */
    getClient(): RedisClientType;
}
declare function createRedisState(options?: Partial<RedisStateAdapterOptions>): RedisStateAdapter;

export { RedisStateAdapter, type RedisStateAdapterOptions, createRedisState };
