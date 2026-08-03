'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import BigLoader from '@/components/BigLoader';

export function ContinueClient({ to }: { to: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(to);
  }, [router, to]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-12">
      <BigLoader title="Continuing" />
      <noscript>
        <a href={to} className="underline">
          Continue
        </a>
      </noscript>
    </div>
  );
}
