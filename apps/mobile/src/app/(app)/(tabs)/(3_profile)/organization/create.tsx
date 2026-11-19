import { CreateOrganizationScreen } from '@/components/organization/create-organization-screen';

export default function CreateOrganizationRoute() {
  // No stack repair: the Profile tab's row opens create over the tab root, not
  // over the hub, and the screen's completion handles both entries by itself
  // (`create-organization-screen.tsx`). Rebuilding the hub beneath it would
  // point Back at a hub the reader never passed through.
  return <CreateOrganizationScreen />;
}
