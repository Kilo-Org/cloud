import { notFound } from 'next/navigation';
import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { isFeatureFlagEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';

export default async function CreatePage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/app-builder');

  const isAppBuilderEnabled = await isFeatureFlagEnabled('app-builder-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAppBuilderEnabled && !isDevelopment) {
    return notFound();
  }

  return <AppBuilderPage organizationId={undefined} projectId={undefined} />;
}
