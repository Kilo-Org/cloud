import { notFound } from 'next/navigation';
import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectPage({ params }: Props) {
  const { projectId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/app-builder/${projectId}`
  );

  const isAppBuilderEnabled = await isFeatureFlagEnabled('app-builder-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAppBuilderEnabled && !isDevelopment) {
    return notFound();
  }

  return <AppBuilderPage organizationId={undefined} projectId={projectId} />;
}
