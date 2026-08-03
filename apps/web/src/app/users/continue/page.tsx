import { resolveHandoffDestination } from '@/lib/app-link-safe-redirect';
import { ContinueClient } from './ContinueClient';

export default async function ContinuePage({ searchParams }: AppPageProps) {
  const to = resolveHandoffDestination((await searchParams).to);
  return <ContinueClient to={to} />;
}
