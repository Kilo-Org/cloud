'use client';

// Web Jest compiles JSX with the classic runtime, which needs React in scope.
import React, { useState } from 'react';
import type { CustomRouterSummary } from '@kilocode/auto-routing-contracts';
import { Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PoolBenchmarkDialog } from './PoolBenchmarkDialog';

type Props = {
  router: CustomRouterSummary;
  organizationId: string | undefined;
};

export function PoolBenchmarkButton({ router, organizationId }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Gauge className="size-4" aria-hidden />
        Benchmark pool
      </Button>
      {open ? (
        <PoolBenchmarkDialog
          router={router}
          organizationId={organizationId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
