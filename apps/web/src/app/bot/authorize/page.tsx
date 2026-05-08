import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { type PlatformId } from '../_components/platforms';
import { AuthorizeFlow } from './_components/AuthorizeFlow';

export const metadata: Metadata = {
  title: 'Authorize Kilo',
  description: 'Connect Kilo to the services your team uses.',
};

const KNOWN_IDS = new Set<PlatformId>([
  'slack',
  'discord',
  'microsoft-teams',
  'google-chat',
  'github',
  'gitlab',
  'linear',
]);

function parseServices(raw: string | string[] | undefined): PlatformId[] {
  if (!raw) return [];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  const seen = new Set<PlatformId>();
  for (const part of value.split(',')) {
    const id = part.trim() as PlatformId;
    if (KNOWN_IDS.has(id)) seen.add(id);
  }
  return Array.from(seen);
}

export default async function BotAuthorizePage({ searchParams }: AppPageProps) {
  const params = await searchParams;
  const services = parseServices(params?.services);

  if (services.length === 0) {
    redirect('/bot');
  }

  return (
    <KiloCardLayout bare className="max-w-xl" contentClassName="">
      <AuthorizeFlow serviceIds={services} />
    </KiloCardLayout>
  );
}
