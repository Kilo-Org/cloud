export type WastelandMemberResult = {
    member_id: string;
    user_id: string;
    trust_level: number;
    role: 'contributor' | 'maintainer' | 'owner';
    joined_at: string;
};
export declare function initializeDatabase(sql: SqlStorage): void;
export declare function listMembers(sql: SqlStorage, wastelandId: string): WastelandMemberResult[];
export declare function addMember(sql: SqlStorage, wastelandId: string, userId: string, role: string, trustLevel: number): string;
export declare function removeMember(sql: SqlStorage, memberId: string): void;
export declare function getMember(sql: SqlStorage, wastelandId: string, userId: string): WastelandMemberResult | null;
export declare function updateMember(sql: SqlStorage, wastelandId: string, memberId: string, update: {
    role?: string;
    trust_level?: number;
}): WastelandMemberResult | null;
