import { StateAdapter, Lock } from 'chat';

/**
 * In-memory state adapter for development and testing.
 *
 * WARNING: State is not persisted across restarts.
 * Use RedisStateAdapter for production.
 */
declare class MemoryStateAdapter implements StateAdapter {
    private readonly subscriptions;
    private readonly locks;
    private readonly cache;
    private connected;
    private connectPromise;
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
    private cleanExpiredLocks;
    _getSubscriptionCount(): number;
    _getLockCount(): number;
}
declare function createMemoryState(): MemoryStateAdapter;

export { MemoryStateAdapter, createMemoryState };
