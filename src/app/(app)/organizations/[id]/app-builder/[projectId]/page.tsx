import { redirect } from 'next/navigation';
import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@/lib/user.server';

type Props = {
  params: Promise<{ id: string; projectId: string }>;
};

export default async function OrgAppBuilderProjectPage({ params }: Props) {
  const { id, projectId } = await params;
  const organizationId = decodeURIComponent(id);

  const result = await getAuthorizedOrgContext(organizationId);
  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    redirect('/profile');
  }

  return <AppBuilderPage organizationId={organizationId} projectId={projectId} />;
}
