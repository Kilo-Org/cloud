'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { TRPCClientError } from '@trpc/client';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import type { InstallPayload } from '@/lib/kiloclaw/install';
import type { InstallSource } from '@/lib/kiloclaw/install-sources';

type InstallClientProps = {
  source: InstallSource;
  sourceLabel: string;
  payload: InstallPayload;
};

/**
 * Install preview + explicit dispatch. The signed payload was fetched and
 * verified server-side (and paid-access gated) in `page.tsx`; this shows the
 * user what's about to be installed.
 *
 * Dispatch happens ONLY on an explicit Install click, which fires the
 * `installFromSource` POST mutation — never on GET render. A cross-site POST
 * can't carry the SameSite session cookie, so this closes the CSRF /
 * lure-a-click class that a GET-dispatch route would re-open.
 */
export function InstallClient({ source, sourceLabel, payload }: InstallClientProps) {
  const router = useRouter();
  const trpc = useTRPC();
  // `navigating` keeps the button disabled through the post-success redirect
  // so a double-click can't fire a second dispatch while the route changes.
  const [navigating, setNavigating] = useState(false);
  const install = useMutation(trpc.kiloclaw.installFromSource.mutationOptions());

  async function onInstall() {
    try {
      const result = await install.mutateAsync({ source, slug: payload.slug });
      setNavigating(true);
      if (result.ok) {
        router.push('/claw/chat');
        return;
      }
      // No active instance yet — send them to set one up. We intentionally do
      // NOT persist the install intent across the (long, multi-step) onboarding
      // flow; the user finishes setup, then installs again from the byte page.
      // Re-running the install link is cheap and predictable.
      router.push('/claw/new');
    } catch (err) {
      const message =
        err instanceof TRPCClientError && err.data?.code === 'NOT_FOUND'
          ? 'This install link is no longer available.'
          : 'Could not install this byte. Please try again.';
      toast.error(message);
    }
  }

  const busy = install.isPending || navigating;

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <p className="text-muted-foreground text-sm tracking-wide uppercase">{sourceLabel}</p>
      <h1 className="text-2xl font-semibold">{payload.title}</h1>
      <p className="text-muted-foreground text-sm">{payload.description}</p>
      <Button type="button" onClick={onInstall} disabled={busy} className="mt-2">
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        {busy ? 'Installing…' : 'Install'}
      </Button>
      <Link href="/claw/chat" className="text-muted-foreground text-sm underline">
        Cancel
      </Link>
    </div>
  );
}
