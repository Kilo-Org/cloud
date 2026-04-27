import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import ProductOptionsContent from './personal/_components/ProductOptionsContent';
import Link from 'next/link';
import { Users } from 'lucide-react';
import HeaderLogo from '@/components/HeaderLogo';
import { PageContainer } from '@/components/layouts/PageContainer';

export default async function GetStartedPage() {
  // Optional: Check if user is authenticated but don't require it
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });

  // If authenticated and needs verification, redirect
  if (user && user.has_validation_stytch === null) {
    redirect('/account-verification');
  }

  const isAuthenticated = !!user;
  const orgLink = isAuthenticated
    ? '/organizations/new'
    : '/users/sign_in?callbackPath=/organizations/new';

  return (
    <PageContainer className="min-h-screen max-w-7xl py-5 md:py-7">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <HeaderLogo />
        <ProductOptionsContent isAuthenticated={isAuthenticated} />
        <Link
          href={orgLink}
          className="ring-border bg-card/30 hover:ring-brand-primary/70 group flex items-center justify-between gap-4 rounded-2xl p-3.5 ring-1 transition-all"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
              <Users className="text-muted-foreground h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">Using Kilo for work?</p>
              <p className="text-muted-foreground text-xs sm:text-sm">
                Create a team workspace for shared credits, access controls, and collaboration.
              </p>
            </div>
          </div>
          <span className="text-brand-primary hidden text-sm font-semibold sm:inline">
            Create team
          </span>
        </Link>
      </div>
    </PageContainer>
  );
}
