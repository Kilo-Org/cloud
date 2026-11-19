import { useLocalSearchParams } from 'expo-router';

import { OrganizationModeFormScreen } from '@/components/organization/mode-form-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';
import { parseParam } from '@/lib/route-params';

/** The path that re-opens this screen above the organization hub. */
const MODE_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/mode-form';

export default function OrganizationModeFormRoute() {
  const { modeId } = useLocalSearchParams<{ modeId?: string | string[] }>();
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree. The href carries the mode the reader opened: the
  // rebuilt push is a query string, because the object form drops params
  // (`profile-route-stack.ts`), and a rebuilt edit form without its mode
  // would open as an empty create form.
  const modeIdParam = parseParam(modeId);
  const self =
    modeIdParam !== null
      ? `${MODE_FORM_PATH}?modeId=${encodeURIComponent(modeIdParam)}`
      : MODE_FORM_PATH;
  useRepairOrganizationRouteStack({ self });
  return <OrganizationModeFormScreen />;
}
