'use client';

import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';

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

export default function ClawPage() {
  const router = useRouter();
  const { data: status, isLoading, error } = useKiloClawStatus();
  const redirectPath = status?.status ? '/claw/chat' : '/claw/new';

  useEffect(() => {
    if (!isLoading && !error) {
      router.replace(redirectPath);
    }
  }, [error, isLoading, redirectPath, router]);

  if (error) {
    return (
      <div
        className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
        style={{ minHeight: '50vh' }}
      >
        <p className="text-destructive text-sm">
          Unable to load KiloClaw status. Please refresh the page or try again later.
        </p>
      </div>
    );
  }

  return <LoadingState />;
}
