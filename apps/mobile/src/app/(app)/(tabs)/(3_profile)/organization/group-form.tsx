import { type Href, useLocalSearchParams } from 'expo-router';

import { OrganizationGroupFormScreen } from '@/components/organization/group-form-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';
import { parseParam } from '@/lib/route-params';

/** The path that re-opens this screen above the organization hub. */
const GROUP_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/group-form';

export default function OrganizationGroupFormRoute() {
  const { groupId } = useLocalSearchParams<{ groupId?: string | string[] }>();
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree. The href carries the group the reader opened: the
  // rebuilt push is a query string, because the object form drops params
  // (`profile-route-stack.ts`), and a rebuilt edit form without its group
  // would open as an empty create form.
  const groupIdParam = parseParam(groupId);
  const self: Href =
    groupIdParam !== null
      ? `${GROUP_FORM_PATH}?groupId=${encodeURIComponent(groupIdParam)}`
      : GROUP_FORM_PATH;
  useRepairOrganizationRouteStack({ self });
  return <OrganizationGroupFormScreen />;
}
