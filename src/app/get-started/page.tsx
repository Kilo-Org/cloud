import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import ProductOptionsContent from './personal/_components/ProductOptionsContent';
import Link from 'next/link';
import { Users } from 'lucide-react';

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
    <KiloCardLayout contentClassName="space-y-4 p-4 pt-0">
      <ProductOptionsContent isAuthenticated={isAuthenticated} />
      <div className="pb-2">
        <p className="text-muted-foreground mb-3 text-lg">Using Kilo for work?</p>
        <Link
          href={orgLink}
          className="ring-border hover:ring-muted-foreground group hover:bgmax-w-2xl flex items-center gap-3 rounded-lg p-3 ring-1 transition-all"
        >
          <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
            <Users className="text-muted-foreground h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Create a Team Workspace</p>
            <p className="text-muted-foreground text-xs">
              Collaborate, track usage, and manage access controls
            </p>
          </div>
        </Link>
      </div>
    </KiloCardLayout>
  );
}
