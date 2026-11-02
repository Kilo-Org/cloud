import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

type McpGuardrailsOutputs = inferRouterOutputs<RootRouter>['organizations']['mcpGuardrails'];

export type OrganizationGuardrailRow = McpGuardrailsOutputs['list']['guardrails'][number];
export type McpBrowseItem = McpGuardrailsOutputs['browse']['items'][number];
export type McpBrowseVariant = McpBrowseItem['variants'][number];
