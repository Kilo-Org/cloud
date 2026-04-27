export type ConnectedTownResult = {
    town_id: string;
    wasteland_id: string;
    connected_by: string;
    connected_at: string;
};
export declare function initializeDatabase(sql: SqlStorage): void;
export declare function connectTown(sql: SqlStorage, wastelandId: string, townId: string, userId: string): ConnectedTownResult;
export declare function disconnectTown(sql: SqlStorage, wastelandId: string, townId: string): void;
export declare function listConnectedTowns(sql: SqlStorage, wastelandId: string): ConnectedTownResult[];
