import type { TRPCContext } from './init';
type WastelandOwnershipResult = {
    type: 'user';
    userId: string;
} | {
    type: 'org';
    orgId: string;
} | {
    type: 'admin';
};
export declare function resolveWastelandOwnership(env: Env, ctx: TRPCContext, wastelandId: string): Promise<WastelandOwnershipResult>;
export {};
