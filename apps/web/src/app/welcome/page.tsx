import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import { getExtensionUrl } from '@/components/auth/getExtensionUrl';
import { cookies } from 'next/headers';
import WelcomeContent from '@/components/WelcomeContent';
import HeaderLogo from '@/components/HeaderLogo';
import { PageContainer } from '@/components/layouts/PageContainer';

export default async function WelcomePage({ searchParams }: AppPageProps) {
  // Optional auth check - page is accessible without authentication
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });

  // If authenticated and needs verification, redirect
  if (user && user.has_validation_stytch === null) {
    redirect('/account-verification');
  }

  const params = await searchParams;

  const { ideName, logoSrc, editor } = getExtensionUrl(params, await cookies());
  // Only check credits if user is authenticated
  const hasCredits = user ? user.total_microdollars_acquired > 0 : false;

  return (
    <PageContainer>
      <div className="flex min-h-screen flex-col items-center justify-between gap-12">
        <div className="self-start">
          <HeaderLogo />
        </div>
        <WelcomeContent
          ideName={ideName}
          logoSrc={logoSrc}
          hasCredits={hasCredits}
          editor={editor}
          isAuthenticated={!!user}
        />
        <div className="text-muted-foreground flex items-center justify-center text-xs">
          © {new Date().getFullYear()} Kilo Code
        </div>
      </div>
    </PageContainer>
  );
}
