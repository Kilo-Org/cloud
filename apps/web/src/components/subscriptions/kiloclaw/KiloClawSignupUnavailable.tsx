import React from 'react';
import { CircleOff } from 'lucide-react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function KiloClawSignupUnavailable() {
  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader className="items-center text-center">
        <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
          <CircleOff aria-hidden="true" className="size-5" />
        </div>
        <CardTitle>New KiloClaw instances are unavailable</CardTitle>
        <CardDescription>
          A current KiloClaw subscription is required to provision an instance. Existing instances
          and subscriptions continue as normal.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
