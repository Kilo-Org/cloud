import { buildLandingRedirectUrl } from '@/lib/landing-redirect';
import { redirect } from 'next/navigation';

export default async function GetStartedPage({ searchParams }: AppPageProps) {
  redirect(buildLandingRedirectUrl('/install', await searchParams));
}
