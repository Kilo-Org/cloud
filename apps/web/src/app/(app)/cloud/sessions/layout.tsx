import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { smartAppBannerItunes } from '@/lib/smart-app-banner';

export const metadata = { itunes: smartAppBannerItunes('/cloud/sessions') };

export default async function CloudSessionsLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
