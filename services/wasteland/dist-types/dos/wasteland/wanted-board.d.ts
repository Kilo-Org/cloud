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
export declare function initializeDatabase(sql: SqlStorage): void;
export declare function getWantedBoard(sql: SqlStorage, wastelandId: string): WantedItemResult[];
export declare function refreshWantedBoard(sql: SqlStorage, wastelandId: string): WantedItemResult[];
