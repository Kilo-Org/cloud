'use client';

import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { ClawStatusError } from '@/app/(app)/claw/components/ClawStatusError';

function LoadingState() {
  return (
    <div
      className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
      style={{ minHeight: '50vh' }}
    >
      <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
    </div>
  );
}

export function OrgClawRedirectClient({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const { data: status, isLoading, error, refetch } = useOrgKiloClawStatus(organizationId);
  const basePath = `/organizations/${organizationId}/claw`;
  const redirectPath = status?.status ? `${basePath}/chat` : `${basePath}/new`;

  useEffect(() => {
    if (!isLoading && !error) {
      router.replace(redirectPath);
    }
  }, [error, isLoading, redirectPath, router]);

  if (error) {
    return (
      <div className="container m-auto w-full max-w-[1140px] p-4 md:p-6">
        <ClawStatusError error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  return <LoadingState />;
}
