import { OrganizationGuardrailsScreen } from '@/components/organization/guardrails-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';

/** The path that re-opens this screen above the organization hub. */
const GUARDRAILS_PATH =
  '/(app)/(tabs)/(3_profile)/organization/guardrails' as const;

export default function OrganizationGuardrailsRoute() {
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree.
  useRepairOrganizationRouteStack({ self: GUARDRAILS_PATH });
  return <OrganizationGuardrailsScreen />;
}
