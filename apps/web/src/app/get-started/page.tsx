import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import ProductOptionsContent from './personal/_components/ProductOptionsContent';
import { PageContainer } from '@/components/layouts/PageContainer';

export default async function GetStartedPage() {
  // Optional: Check if user is authenticated but don't require it
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });

  // If authenticated and needs verification, redirect
  if (user && user.has_validation_stytch === null) {
    redirect('/account-verification');
  }

  const isAuthenticated = !!user;

  return (
    <PageContainer className="min-h-screen max-w-7xl justify-center py-8 md:py-12">
      <main className="mx-auto w-full max-w-6xl">
        <ProductOptionsContent isAuthenticated={isAuthenticated} />
      </main>
    </PageContainer>
  );
}
