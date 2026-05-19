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

export default async function CollabAuthorizePage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/collab');
  if (user.is_admin !== true) notFound();

  const params = await searchParams;
  const services = parseServices(params?.services);

  return (
    <KiloCardLayout bare className="max-w-xl" contentClassName="">
      <AuthorizeFlow serviceIds={services} />
    </KiloCardLayout>
  );
}
