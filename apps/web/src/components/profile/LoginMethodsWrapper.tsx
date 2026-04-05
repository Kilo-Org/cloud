'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { LoginMethodsCard } from './LoginMethodsCard';
import { ConnectedAccountsCard } from './ConnectedAccountsCard';
import { AuthErrorNotification } from '@/components/auth/AuthErrorNotification';
import { X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountLinkedSuccessHeader } from './AccountLinkedSuccessHeader';
import { AuthProviderIdSchema, getProviderById } from '@/lib/auth/provider-metadata';
import { DiscordGuildStatus } from './DiscordGuildStatus';

type LoginMethodsWrapperProps = {
  primaryEmail: string;
};

export function LoginMethodsWrapper({ primaryEmail }: LoginMethodsWrapperProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [linkedProviderName, setLinkedProviderName] = useState<string | null>(null);
  const trpc = useTRPC();
  const searchParams = useSearchParams();

  const {
    data: providersData,
    isLoading: loading,
    refetch: refetchProviders,
  } = useQuery(trpc.user.getAuthProviders.queryOptions());

  useEffect(() => {
    const error = searchParams.get('error');
    const linked = AuthProviderIdSchema.safeParse(searchParams.get('linked'));
    if (error) {
      setErrorMessage(error);
      const url = new URL(window.location.href);
      url.searchParams.delete('error');
      window.history.replaceState({}, '', url.toString());
    } else if (linked.success) {
      const providerName = getProviderById(linked.data).name;
      setSuccessMessage(`${providerName} account linked successfully!`);
      setLinkedProviderName(providerName);
      const url = new URL(window.location.href);
      url.searchParams.delete('linked');
      window.history.replaceState({}, '', url.toString());
      void refetchProviders();
    }
  }, [searchParams, refetchProviders]);

  const providers = providersData?.providers || [];
  const hasDiscordLinked = providers.some(p => p.provider === 'discord');

  if (loading) {
    return (
      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        {/* Left Card Skeleton */}
        <Card className="h-full w-full rounded-xl shadow-sm">
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 w-28" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right Card Skeleton */}
        <Card className="h-full w-full rounded-xl shadow-sm">
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-6 w-6" />
                    <Skeleton className="h-6 w-6 rounded-full" />
                    <div>
                      <Skeleton className="mb-1 h-4 w-16" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </div>
                  <Skeleton className="h-8 w-16" />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-6 w-6" />
                    <Skeleton className="h-6 w-6 rounded-full" />
                    <div>
                      <Skeleton className="mb-1 h-4 w-16" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                  </div>
                  <Skeleton className="h-8 w-16" />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorMessage && (
        <div className="relative">
          <AuthErrorNotification error={errorMessage} />
          <button
            onClick={() => setErrorMessage(null)}
            className="absolute top-2 right-2 rounded-full bg-red-100 p-1 hover:bg-red-200"
            aria-label="Close error"
          >
            <X className="h-4 w-4 text-red-600" />
          </button>
        </div>
      )}

      {successMessage && (
        <AccountLinkedSuccessHeader
          providerName={linkedProviderName || 'Account'}
          onDismiss={() => {
            setSuccessMessage(null);
            setLinkedProviderName(null);
          }}
        />
      )}

      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        <LoginMethodsCard
          primaryEmail={primaryEmail}
          providers={providers}
          onError={setErrorMessage}
        />
        <ConnectedAccountsCard
          providers={providers}
          onRefetch={refetchProviders}
          onError={setErrorMessage}
        />
      </div>

      <DiscordGuildStatus hasDiscordLinked={hasDiscordLinked} />
    </div>
  );
}
