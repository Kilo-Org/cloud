import { DurableObject } from 'cloudflare:workers';
import { WastelandRegistryRecord } from '../db/tables/wasteland-registry.table';
/**
 * WastelandRegistryDO — singleton registry that indexes wasteland ownership.
 *
 * Because each WastelandDO is per-wasteland, we need a central index to
 * answer "which wastelands does user X own?" or "which wastelands belong
 * to org Y?". This singleton (keyed by fixed name 'registry') maintains
 * that mapping.
 *
 * All creates/deletes in the tRPC router update this registry so
 * listWastelands can resolve ownership without scanning every WastelandDO.
 */
export declare class WastelandRegistryDO extends DurableObject<Env> {
    private sql;
    private initPromise;
    constructor(ctx: DurableObjectState, env: Env);
    private ensureInitialized;
    private initializeDatabase;
    register(input: {
        wasteland_id: string;
        owner_type: 'user' | 'org';
        owner_user_id: string | null;
        organization_id: string | null;
        name: string;
    }): Promise<void>;
    unregister(wastelandId: string): Promise<void>;
    listByUser(userId: string): Promise<WastelandRegistryRecord[]>;
    listByOrg(orgId: string): Promise<WastelandRegistryRecord[]>;
    listAll(): Promise<WastelandRegistryRecord[]>;
    /** Return the total number of registered (active) wastelands. */
    countAll(): Promise<number>;
}
export declare function getWastelandRegistryStub(env: Env): DurableObjectStub<WastelandRegistryDO>;
