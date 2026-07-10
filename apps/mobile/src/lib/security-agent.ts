import { type OrganizationRole } from '@kilocode/app-shared/organizations';
import { type inferRouterInputs, type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { type Href } from 'expo-router';

type RouterInputs = inferRouterInputs<RootRouter>;
type RouterOutputs = inferRouterOutputs<RootRouter>;

export type SecurityAgentConfig = RouterOutputs['securityAgent']['getConfig'];
export type SecurityAgentConfigPatch = RouterInputs['securityAgent']['saveConfig'];
export type SecurityFinding = RouterOutputs['securityAgent']['getFinding'];
export type SecurityAnalysis = RouterOutputs['securityAgent']['getAnalysis'];
export type SecurityCommand = NonNullable<RouterOutputs['securityAgent']['getCommandStatus']>;
export type { OrganizationRole };

export function getSecurityAgentPath(scope: string, suffix = ''): Href {
  const path = `/(app)/(tabs)/(3_profile)/security-agent/${scope}`;
  return (suffix ? `${path}/${suffix}` : path) as Href;
}
