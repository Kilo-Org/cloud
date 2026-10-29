import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

type AddonsOutputs = inferRouterOutputs<RootRouter>['organizations']['addons'];

export type OrganizationAddonRow = AddonsOutputs['list']['addons'][number];
export type McpBrowseItem = AddonsOutputs['browse']['items'][number];
export type McpBrowseVariant = McpBrowseItem['variants'][number];
