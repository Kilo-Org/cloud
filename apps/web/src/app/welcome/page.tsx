import { buildLandingRedirectUrl } from '@/lib/landing-redirect';
import { redirect } from 'next/navigation';

export default async function WelcomePage({ searchParams }: AppPageProps) {
  redirect(buildLandingRedirectUrl('/welcome', await searchParams));
}
