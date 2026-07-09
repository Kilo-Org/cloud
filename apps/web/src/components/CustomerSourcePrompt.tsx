'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ORGANIZATION_WELCOME_PATH = /^\/organizations\/[0-9a-f-]{36}\/welcome$/;

export function shouldShowCustomerSourcePrompt(
  customerSource: string | null | undefined,
  pathname: string
): boolean {
  return (
    customerSource === null &&
    pathname !== '/gastown/onboarding' &&
    !ORGANIZATION_WELCOME_PATH.test(pathname)
  );
}

export function CustomerSourcePrompt() {
  const pathname = usePathname();
  const { data: user } = useUser();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [source, setSource] = useState('');
  const [dismissed, setDismissed] = useState(false);

  function completePrompt() {
    setDismissed(true);
    void queryClient.invalidateQueries({ queryKey: ['user'] });
  }

  const submitSource = useMutation(
    trpc.user.submitCustomerSource.mutationOptions({
      onSuccess: completePrompt,
    })
  );
  const dismissPrompt = useMutation(
    trpc.user.skipCustomerSource.mutationOptions({
      onSuccess: completePrompt,
    })
  );

  const isPending = submitSource.isPending || dismissPrompt.isPending;
  const error = submitSource.error ?? dismissPrompt.error;

  if (dismissed || !shouldShowCustomerSourcePrompt(user?.customer_source, pathname)) {
    return null;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedSource = source.trim();
    if (trimmedSource) submitSource.mutate({ source: trimmedSource });
  }

  return (
    <aside
      aria-labelledby="customer-source-prompt-title"
      className="fixed right-4 bottom-[max(5rem,env(safe-area-inset-bottom))] z-40 w-[calc(100vw-2rem)] max-w-sm sm:right-5"
    >
      <Card className="bg-card/95 shadow-lg backdrop-blur-sm">
        <CardHeader className="p-4 pb-3">
          <CardTitle id="customer-source-prompt-title">
            Where did you hear about Kilo Code?
          </CardTitle>
          <CardDescription>A short answer helps us understand what is working.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="customer-source">Source</Label>
              <Input
                id="customer-source"
                value={source}
                onChange={event => setSource(event.target.value)}
                placeholder="GitHub, a teammate, YouTube..."
                maxLength={1000}
                disabled={isPending}
                aria-invalid={error !== null}
                aria-describedby={error ? 'customer-source-error' : undefined}
              />
              {error && (
                <p id="customer-source-error" className="text-destructive type-body" role="alert">
                  We could not save your answer. Please try again.
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => dismissPrompt.mutate()}
                disabled={isPending}
                className="h-control-touch px-3"
              >
                {dismissPrompt.isPending && (
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                )}
                {dismissPrompt.isPending ? 'Dismissing...' : 'Dismiss'}
              </Button>
              <Button
                type="submit"
                disabled={isPending || source.trim().length === 0}
                className="h-control-touch px-4"
              >
                {submitSource.isPending && (
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                )}
                Save answer
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </aside>
  );
}
