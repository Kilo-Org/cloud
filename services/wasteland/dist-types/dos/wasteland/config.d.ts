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
export declare function initializeDatabase(sql: SqlStorage): void;
export declare function initializeWasteland(sql: SqlStorage, input: InitializeWastelandInput): WastelandConfigResult;
export declare function getConfig(sql: SqlStorage, wastelandId: string): WastelandConfigResult | null;
export declare function updateConfig(sql: SqlStorage, wastelandId: string, update: UpdateWastelandConfigInput): WastelandConfigResult;
