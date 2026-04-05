import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function CreatePage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/app-builder');

  return <AppBuilderPage organizationId={undefined} projectId={undefined} />;
}
