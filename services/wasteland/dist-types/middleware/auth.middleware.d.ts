export type JwtOrgMembership = {
    orgId: string;
    role: 'owner' | 'member' | 'billing_manager';
};
export type AuthVariables = {
    kiloUserId: string;
    kiloIsAdmin: boolean;
    kiloApiTokenPepper: string | null;
    kiloOrgMemberships: JwtOrgMembership[];
    requestStartTime: number;
};
