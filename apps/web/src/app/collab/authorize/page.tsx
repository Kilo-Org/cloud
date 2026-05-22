import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { ALL_PLATFORM_IDS, type PlatformId } from '../_components/platforms';
import { AuthorizeFlow } from './_components/AuthorizeFlow';

export const metadata: Metadata = {
  title: 'Authorize Kilo',
  description: 'Connect Kilo to the services your team uses.',
};

function isPlatformId(value: string): value is PlatformId {
  return ALL_PLATFORM_IDS.has(value);
}

function parseServices(raw: string | string[] | undefined): PlatformId[] {
  if (!raw) return [];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  const seen = new Set<PlatformId>();
  for (const part of value.split(',')) {
    const id = part.trim();
    if (isPlatformId(id)) seen.add(id);
  }
  return Array.from(seen);
}

function parseStep(raw: string | string[] | undefined, serviceCount: number): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = value ? Number.parseInt(value, 10) : 0;
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, serviceCount);
}

function hasSuccessfulCallback(params: NextAppSearchParams | undefined): boolean {
  const success = Array.isArray(params?.success) ? params.success[0] : params?.success;
  const githubInstall = Array.isArray(params?.github_install)
    ? params.github_install[0]
    : params?.github_install;
  const githubPendingApproval = Array.isArray(params?.github_pending_approval)
    ? params.github_pending_approval[0]
    : params?.github_pending_approval;

  return (
    success === 'slack_installed' ||
    success === 'discord_installed' ||
    success === 'linear_installed' ||
    success === 'gitlab_connected' ||
    githubInstall === 'success' ||
    githubPendingApproval === 'true'
  );
}

function getCallbackError(params: NextAppSearchParams | undefined): string | undefined {
  const error = Array.isArray(params?.error) ? params.error[0] : params?.error;
  if (!error) return undefined;

  const messages: Record<string, string> = {
    access_denied: 'Authorization was canceled. You can try again or skip this service for now.',
    connection_failed: 'Authorization failed. You can try again or skip this service for now.',
    installation_failed: 'Installation failed. You can try again or skip this service for now.',
    invalid_state: 'This authorization session expired. Start authorization again to continue.',
    missing_code: 'The service did not return an authorization code. Try authorizing again.',
    missing_installation_id: 'GitHub did not return an installation ID. Try authorizing again.',
    oauth_init_failed:
      'Authorization could not be started. Try again or skip this service for now.',
    pending_installation_exists:
      'You already have a pending GitHub installation. Complete or cancel it before trying again.',
    pending_setup_failed: 'The pending GitHub installation could not be saved. Try again.',
    unauthorized: 'This authorization was started by another user. Start authorization again.',
    workspace_already_connected:
      'That workspace is already connected elsewhere. Choose another workspace or skip this service.',
  };

  return messages[error] ?? 'Authorization failed. You can try again or skip this service for now.';
}

export default async function CollabAuthorizePage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/collab');
  if (user.is_admin !== true) notFound();

  const params = await searchParams;
  const services = parseServices(params?.services);
  const connectedServices = parseServices(params?.connected);
  const organizationId = Array.isArray(params?.organizationId)
    ? params.organizationId[0]
    : params?.organizationId;
  const step = parseStep(params?.step, services.length);
  const successfulCallback = hasSuccessfulCallback(params);
  const initialIndex = successfulCallback ? Math.min(step + 1, services.length) : step;
  const initialError = successfulCallback ? undefined : getCallbackError(params);

  return (
    <KiloCardLayout bare className="max-w-xl" contentClassName="">
      <AuthorizeFlow
        serviceIds={services}
        connectedServiceIds={connectedServices}
        organizationId={organizationId}
        initialIndex={initialIndex}
        initialError={initialError}
      />
    </KiloCardLayout>
  );
}
