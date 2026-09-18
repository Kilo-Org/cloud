import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/**
 * The tRPC output shapes the profile screens and hooks share. Kept in their own
 * module so the query hooks and the mutation hook can both depend on them
 * without importing each other.
 */
type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** A profile summary as the list surfaces render it. Org summaries add `ownerType`. */
export type AgentProfileListItem = RouterOutputs['agentProfiles']['list'][number] & {
  ownerType?: 'organization' | 'user';
};

export type AgentProfileListCombined = RouterOutputs['agentProfiles']['listCombined'];
export type AgentProfileDetail = RouterOutputs['agentProfiles']['get'];

/** One repo-to-profile binding as `listRepoBindings` returns it. */
export type AgentRepoBinding = RouterOutputs['agentProfiles']['listRepoBindings'][number];
