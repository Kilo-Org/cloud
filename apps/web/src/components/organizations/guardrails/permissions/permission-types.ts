import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

type PermissionRulesOutputs = inferRouterOutputs<RootRouter>['organizations']['permissionRules'];

export type PermissionRuleRow = PermissionRulesOutputs['list']['rules'][number];
export type PermissionEventRow = PermissionRulesOutputs['listEvents']['events'][number];
