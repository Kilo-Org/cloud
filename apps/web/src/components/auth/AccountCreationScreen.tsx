'use client';

import dynamic from 'next/dynamic';
import { PageContainer } from '@/components/layouts/PageContainer';

const AccountCreationStatus = dynamic(
  () =>
    import('@/components/auth/AccountCreationStatus').then(module => module.AccountCreationStatus),
  { ssr: false }
);

export function AccountCreationScreen() {
  return (
    <PageContainer className="min-h-screen">
      <main className="flex flex-1 items-center justify-center">
        <AccountCreationStatus />
      </main>
    </PageContainer>
  );
}
