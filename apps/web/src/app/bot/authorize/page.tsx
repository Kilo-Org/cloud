import type { Metadata } from 'next';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { type PlatformId } from '../_components/platforms';
import { AuthorizeFlow } from './_components/AuthorizeFlow';

export const metadata: Metadata = {
  title: 'Authorize Kilo',
  description: 'Connect Kilo to the services your team uses.',
};

const KNOWN_IDS = new Set<string>([
  'slack',
  'discord',
  'microsoft-teams',
  'google-chat',
  'github',
  'gitlab',
  'linear',
]);

function isPlatformId(value: string): value is PlatformId {
  return KNOWN_IDS.has(value);
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

export type WorkspaceContext = { type: 'org'; id: string } | { type: 'personal' };

function parseWorkspace(raw: string | string[] | undefined): WorkspaceContext {
  if (!raw) return { type: 'personal' };
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value.startsWith('org:')) {
    return { type: 'org', id: value.slice(4) };
  }
  return { type: 'personal' };
}

export default async function BotAuthorizePage({ searchParams }: AppPageProps) {
  const params = await searchParams;
  const services = parseServices(params?.services);
  const workspace = parseWorkspace(params?.workspace);

  return (
    <KiloCardLayout bare className="max-w-xl" contentClassName="">
      <AuthorizeFlow serviceIds={services} workspace={workspace} />
    </KiloCardLayout>
  );
}
