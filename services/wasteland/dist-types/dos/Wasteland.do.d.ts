import { DurableObject } from 'cloudflare:workers';
export type WastelandConfigResult = {
    wasteland_id: string;
    name: string;
    owner_type: 'user' | 'org';
    owner_user_id: string | null;
    organization_id: string | null;
    dolthub_upstream: string | null;
    visibility: 'public' | 'private';
    status: 'active' | 'deleted';
    created_at: string;
    updated_at: string;
};
export type WastelandMemberResult = {
    member_id: string;
    user_id: string;
    trust_level: number;
    role: 'contributor' | 'maintainer' | 'owner';
    joined_at: string;
};
export type InitializeWastelandInput = {
    wasteland_id: string;
    name: string;
    owner_type: 'user' | 'org';
    owner_user_id: string | null;
    organization_id: string | null;
    dolthub_upstream: string | null;
    visibility: 'public' | 'private';
};
export type UpdateWastelandConfigInput = {
    name?: string;
    visibility?: 'public' | 'private';
    dolthub_upstream?: string | null;
    status?: 'active' | 'deleted';
};
export type WastelandCredentialResult = {
    user_id: string;
    encrypted_token: string;
    dolthub_org: string;
    rig_handle: string | null;
    is_upstream_admin: boolean;
    connected_at: string;
};
export type ConnectedTownResult = {
    town_id: string;
    wasteland_id: string;
    connected_by: string;
    connected_at: string;
};
export type WantedItemResult = {
    item_id: string;
    title: string;
    description: string;
    status: 'open' | 'claimed' | 'done';
    priority: 'low' | 'medium' | 'high' | 'critical';
    type: 'feature' | 'bug' | 'docs' | 'other';
    claimed_by: string | null;
    evidence: string | null;
    created_at: string;
    updated_at: string;
};
export declare class WastelandDO extends DurableObject<Env> {
    private state;
    private sql;
    private wastelandId;
    constructor(state: DurableObjectState, env: Env);
    private initializeDatabase;
    initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfigResult>;
    getConfig(): Promise<WastelandConfigResult | null>;
    updateConfig(input: UpdateWastelandConfigInput): Promise<WastelandConfigResult>;
    listMembers(): Promise<WastelandMemberResult[]>;
    addMember(userId: string, role: string, trustLevel: number): Promise<string>;
    removeMember(memberId: string): Promise<void>;
    getMember(userId: string): Promise<WastelandMemberResult | null>;
    updateMember(memberId: string, update: {
        role?: string;
        trust_level?: number;
    }): Promise<WastelandMemberResult | null>;
    storeCredential(input: {
        userId: string;
        encryptedToken: string;
        dolthubOrg: string;
        rigHandle?: string;
        isUpstreamAdmin?: boolean;
    }): Promise<WastelandCredentialResult>;
    getCredential(userId: string): Promise<WastelandCredentialResult | null>;
    setIsUpstreamAdmin(userId: string, isUpstreamAdmin: boolean): Promise<WastelandCredentialResult | null>;
    deleteCredential(userId: string): Promise<void>;
    connectTown(townId: string, userId: string): Promise<ConnectedTownResult>;
    disconnectTown(townId: string): Promise<void>;
    listConnectedTowns(): Promise<ConnectedTownResult[]>;
    getWantedBoard(): Promise<WantedItemResult[]>;
    refreshWantedBoard(): Promise<WantedItemResult[]>;
}
export declare function getWastelandDOStub(env: Env, wastelandId: string): DurableObjectStub<WastelandDO>;
