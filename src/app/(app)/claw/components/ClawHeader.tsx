'use client';

import { Terminal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AccessCodeActions } from './AccessCodeActions';
import { CLAW_STATUS_BADGE, type ClawState } from './claw.types';

export function ClawHeader({
  status,
  sandboxId,
  region,
  gatewayUrl,
}: {
  status: ClawState;
  sandboxId: string | null;
  region: string | null;
  gatewayUrl: string;
}) {
  const statusInfo = status ? CLAW_STATUS_BADGE[status] : null;

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="bg-secondary flex h-10 w-10 items-center justify-center rounded-lg">
          <Terminal className="text-muted-foreground h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-foreground text-lg font-semibold tracking-tight">Kilo Claw</h1>
            {statusInfo && (
              <Badge variant="outline" className={statusInfo.className}>
                {statusInfo.label}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground font-mono text-sm">
            {region || 'Region pending'} {sandboxId ? `- ${sandboxId}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AccessCodeActions canShow={status === 'running'} gatewayUrl={gatewayUrl} />
      </div>
    </header>
  );
}
