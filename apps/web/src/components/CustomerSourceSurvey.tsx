'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useUser } from '@/hooks/useUser';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ORGANIZATION_WELCOME_PATH = /^\/organizations\/[0-9a-f-]{36}\/welcome$/;

export function shouldShowCustomerSourceSurvey(
  customerSource: string | null | undefined,
  pathname: string
): boolean {
  return (
    customerSource === null &&
    pathname !== '/gastown/onboarding' &&
    !ORGANIZATION_WELCOME_PATH.test(pathname)
  );
}

export function CustomerSourceSurvey() {
  const [source, setSource] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const pathname = usePathname();
  const { data: user } = useUser();
  const trpc = useTRPC();

  const submitSource = useMutation(
    trpc.user.submitCustomerSource.mutationOptions({
      onSuccess: () => setDismissed(true),
    })
  );

  const skipSource = useMutation(
    trpc.user.skipCustomerSource.mutationOptions({
      onSuccess: () => setDismissed(true),
    })
  );

  if (dismissed || !shouldShowCustomerSourceSurvey(user?.customer_source, pathname)) {
    return null;
  }

  return (
    <aside className="fixed right-4 bottom-20 z-40 w-[calc(100vw-2rem)] max-w-sm">
      <Card className="shadow-lg">
        <CardHeader className="p-4 pb-3">
          <CardTitle>Where did you hear about Kilo Code?</CardTitle>
          <CardDescription>A short answer helps us understand what is working.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <div className="space-y-1.5">
            <Label htmlFor="customer-source">Source</Label>
            <Input
              id="customer-source"
              placeholder="GitHub, a teammate, YouTube..."
              value={source}
              onChange={event => setSource(event.target.value)}
              maxLength={1000}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => skipSource.mutate()}
              disabled={skipSource.isPending || submitSource.isPending}
            >
              Dismiss
            </Button>
            <Button
              onClick={() => submitSource.mutate({ source: source.trim() })}
              disabled={submitSource.isPending || skipSource.isPending || !source.trim()}
            >
              Save answer
            </Button>
          </div>
        </CardContent>
      </Card>
    </aside>
  );
}
