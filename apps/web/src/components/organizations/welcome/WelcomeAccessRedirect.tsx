'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

type WelcomeAccessRedirectProps = {
  href: string;
};

export function WelcomeAccessRedirect({ href }: WelcomeAccessRedirectProps) {
  const router = useRouter();

  useEffect(() => {
    router.replace(href);
  }, [href, router]);

  return (
    <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      Redirecting…
    </div>
  );
}
