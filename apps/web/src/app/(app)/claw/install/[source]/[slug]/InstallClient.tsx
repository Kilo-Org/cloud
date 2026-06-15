'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { TRPCClientError } from '@trpc/client';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import KiloClawbsterIcon from '@/components/icons/KiloClawbsterIcon';
import type { InstallPayload } from '@/lib/kiloclaw/install';
import type { InstallSource } from '@/lib/kiloclaw/install-sources';

type InstallClientProps = {
  source: InstallSource;
  sourceLabel: string;
  payload: InstallPayload;
};

/**
 * Install confirmation. The signed payload was fetched and verified
 * server-side (and paid-access gated) in `page.tsx`; this is a permission-style
 * confirm screen ("you're installing X from kilo.ai" plus what it does and the
 * description) that the user explicitly confirms or cancels.
 *
 * Dispatch happens ONLY on an explicit Confirm click, which fires the
 * `installFromSource` POST mutation, never on GET render. A cross-site POST
 * can't carry the SameSite session cookie, so this closes the CSRF /
 * lure-a-click class that a GET-dispatch route would re-open.
 */
export function InstallClient({ source, sourceLabel, payload }: InstallClientProps) {
  const router = useRouter();
  const trpc = useTRPC();
  // `navigating` keeps the buttons disabled through the post-success redirect
  // so a double-click can't fire a second dispatch while the route changes.
  const [navigating, setNavigating] = useState(false);
  const install = useMutation(trpc.kiloclaw.installFromSource.mutationOptions());

  async function onInstall() {
    try {
      const result = await install.mutateAsync({
        source,
        slug: payload.slug,
        // Bind the dispatch to the exact payload shown here; the server rejects
        // if the byte changed since this page rendered.
        signature: payload.signature,
      });
      setNavigating(true);
      if (result.ok) {
        // Open the conversation the dispatch created, so the user lands
        // directly in the installed chat, not the blank conversation index.
        router.push(`/claw/chat/${result.conversationId}`);
        return;
      }
      // No active instance yet, so send them to set one up. We intentionally do
      // NOT persist the install intent across the (long, multi-step) onboarding
      // flow; the user finishes setup, then installs again from the byte page.
      router.push('/claw/new');
    } catch (err) {
      let message = 'Could not install this byte. Please try again.';
      if (err instanceof TRPCClientError) {
        if (err.data?.code === 'NOT_FOUND') {
          message = 'This install link is no longer available.';
        } else if (err.data?.code === 'CONFLICT') {
          message = 'This byte changed since you opened this page. Please reload and try again.';
        }
      }
      toast.error(message);
    }
  }

  const busy = install.isPending || navigating;

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg items-center px-6 py-12">
      <Card className="w-full text-left">
        <CardHeader>
          <Badge variant="secondary" className="w-fit gap-1.5">
            <KiloClawbsterIcon className="h-4 w-auto" />
            {sourceLabel}
          </Badge>
          <CardTitle className="mt-2 text-xl break-words">{payload.title}</CardTitle>
          <CardDescription className="leading-relaxed">
            You’re installing a {sourceLabel} from kilo.ai. Clicking Confirm Install starts a new
            KiloClaw conversation and runs its prompt on your behalf. If you don’t want to install
            this, then click Cancel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm font-medium">
            This {sourceLabel} installs a skill to:
          </p>
          <p className="text-foreground mt-2 text-sm leading-relaxed break-words">
            {payload.description}
          </p>
        </CardContent>
        <CardFooter className="justify-end gap-3">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => router.push('/claw/chat')}
          >
            Cancel
          </Button>
          <Button type="button" onClick={onInstall} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? 'Installing…' : 'Confirm Install'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
