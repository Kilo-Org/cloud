'use client';

import { Zap } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { cn } from '@/lib/utils';

const CONFIG_SERVICE_URL = 'https://kilo.ai/kiloclaw/config-service';
const CONFIG_SERVICE_NUDGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function shouldShowConfigServiceBanner(status: KiloClawDashboardStatus | null | undefined) {
  const provisionedAt = status?.provisionedAt;
  return (
    provisionedAt !== null &&
    provisionedAt !== undefined &&
    Date.now() - provisionedAt < CONFIG_SERVICE_NUDGE_WINDOW_MS
  );
}

export function ClawConfigServiceBanner({
  status,
  className,
}: {
  status: KiloClawDashboardStatus | null | undefined;
  className?: string;
}) {
  if (!shouldShowConfigServiceBanner(status)) return null;

  return (
    <div
      className={cn(
        'border-violet-500/30 bg-violet-500/10 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between',
        className
      )}
    >
      <div className="flex items-start gap-3">
        <Zap className="text-violet-400 mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="text-violet-400 text-sm font-semibold">
            Go from inbox chaos to an AI executive assistant - in one hour.
          </p>
          <p className="text-muted-foreground mt-0.5 text-sm">
            A KiloClaw expert configures your email, calendar, and messaging live on a call.
            Includes <b>2 months free</b> hosting.
          </p>
        </div>
      </div>
      <a
        href={CONFIG_SERVICE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-violet-500 text-white hover:bg-violet-500/90 inline-flex shrink-0 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors"
      >
        Book your session
      </a>
    </div>
  );
}

function PersonalClawConfigServiceBannerWithStatus({ className }: { className?: string }) {
  const { data: status } = useKiloClawStatus();
  return <ClawConfigServiceBanner status={status} className={className} />;
}

function OrgClawConfigServiceBannerWithStatus({
  organizationId,
  className,
}: {
  organizationId: string;
  className?: string;
}) {
  const { data: status } = useOrgKiloClawStatus(organizationId);
  return <ClawConfigServiceBanner status={status} className={className} />;
}

export function ClawConfigServiceBannerWithStatus({
  organizationId,
  className,
}: {
  organizationId?: string;
  className?: string;
}) {
  if (organizationId) {
    return (
      <OrgClawConfigServiceBannerWithStatus organizationId={organizationId} className={className} />
    );
  }

  return <PersonalClawConfigServiceBannerWithStatus className={className} />;
}
