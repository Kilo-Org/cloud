import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
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

  return success !== undefined || githubInstall === 'success' || githubPendingApproval === 'true';
}

export default async function CollabAuthorizePage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/collab');
  if (user.is_admin !== true) notFound();

  const params = await searchParams;
  const services = parseServices(params?.services);
  const organizationId = Array.isArray(params?.organizationId)
    ? params.organizationId[0]
    : params?.organizationId;
  const step = parseStep(params?.step, services.length);
  const initialIndex = hasSuccessfulCallback(params) ? Math.min(step + 1, services.length) : step;

  return (
    <KiloCardLayout bare className="max-w-xl" contentClassName="">
      <AuthorizeFlow
        serviceIds={services}
        organizationId={organizationId}
        initialIndex={initialIndex}
      />
    </KiloCardLayout>
  );
}
