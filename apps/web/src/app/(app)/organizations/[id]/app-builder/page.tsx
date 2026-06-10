import { notFound, redirect } from 'next/navigation';
import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { signInUrlWithCallbackPath } from '@/lib/user/server';

type Props = {
  params: Promise<{ id: string }>;
};

export default async function OrgAppBuilderPage({ params }: Props) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);

  const result = await getAuthorizedOrgContext(organizationId);
  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    redirect('/profile');
  }

  const isAppBuilderEnabled = await isFeatureFlagEnabled(
    'app-builder-feature',
    result.data.user.id
  );
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAppBuilderEnabled && !isDevelopment) {
    return notFound();
  }

  return <AppBuilderPage organizationId={organizationId} projectId={undefined} />;
}
