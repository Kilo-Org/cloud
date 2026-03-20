'use client';

import { Badge } from '@/components/ui/badge';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { OpenClawButton } from './OpenClawButton';
import { CLAW_STATUS_BADGE, type ClawState } from './claw.types';

export function ClawHeader({
  status,
  sandboxId,
  region,
  gatewayUrl,
  gatewayReady,
  isSetupWizard,
}: {
  status: ClawState;
  sandboxId: string | null;
  region: string | null;
  gatewayUrl: string;
  gatewayReady?: boolean;
  isSetupWizard?: boolean;
}) {
  const statusInfo = status ? CLAW_STATUS_BADGE[status] : null;
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="bg-secondary flex h-10 w-10 items-center justify-center rounded-lg">
          <KiloCrabIcon className="text-muted-foreground h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-foreground text-lg font-semibold tracking-tight">KiloClaw</h1>
            {statusInfo && (
              <Badge variant="outline" className={statusInfo.className}>
                {statusInfo.label}
              </Badge>
            )}
          </div>
          {!isSetupWizard && region && (
            <p className="text-muted-foreground font-mono text-sm">
              {region.toUpperCase()} {sandboxId ? `- ${sandboxId}` : ''}
            </p>
          )}
        </div>
      </div>
      {!isSetupWizard && (
        <div className="flex flex-wrap items-center gap-2">
          <OpenClawButton
            canShow={status === 'running' && !!gatewayReady}
            gatewayUrl={gatewayUrl}
          />
        </div>
      )}
    </header>
  );
}
