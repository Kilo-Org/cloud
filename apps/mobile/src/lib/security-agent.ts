import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';
import { type Href } from 'expo-router';

type RouterInputs = inferRouterInputs<MobileRouter>;
type RouterOutputs = inferRouterOutputs<MobileRouter>;

export type SecurityAgentConfig = RouterOutputs['securityAgent']['getConfig'];
export type SecurityAgentConfigPatch = RouterInputs['securityAgent']['saveConfig'];
export type SecurityFinding = RouterOutputs['securityAgent']['getFinding'];
export type SecurityAnalysis = RouterOutputs['securityAgent']['getAnalysis'];
export type SecurityCommand = NonNullable<RouterOutputs['securityAgent']['getCommandStatus']>;

export function getSecurityAgentPath(scope: string, suffix = ''): Href {
  const path = `/(app)/(tabs)/(3_profile)/security-agent/${scope}`;
  return (suffix ? `${path}/${suffix}` : path) as Href;
}
