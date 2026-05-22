'use client';

import { AlertCircle, Check, Clock3, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlatformOption } from './platforms';
import { canSelectPlatform, type PlatformSetupStatus } from './setup-status';

type PlatformTileProps = {
  option: PlatformOption;
  selected: boolean;
  setupStatus: PlatformSetupStatus;
  onSelect: () => void;
};

export function PlatformTile({ option, selected, setupStatus, onSelect }: PlatformTileProps) {
  const Icon = option.icon;
  const canSelect = canSelectPlatform(setupStatus);
  const isConnected = setupStatus.kind === 'connected';
  const isUnavailable = setupStatus.kind === 'unavailable';
  const setupDetail = setupStatus.kind === 'connected' ? setupStatus.detail : undefined;
  const detailId = `${option.id}-setup-detail`;
  const hasDescription =
    setupDetail !== undefined || isUnavailable || setupStatus.kind === 'unknown';

  return (
    <button
      type="button"
      onClick={() => {
        if (canSelect) onSelect();
      }}
      aria-disabled={!canSelect}
      aria-pressed={canSelect ? selected : undefined}
      aria-describedby={hasDescription ? detailId : undefined}
      className={cn(
        'group relative flex min-h-40 flex-col items-start gap-4 rounded-xl border bg-card p-4 text-left text-card-foreground',
        'transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        canSelect && 'hover:bg-accent/40 active:scale-[0.99]',
        isConnected
          ? 'border-green-500/30 bg-green-500/10'
          : isUnavailable
            ? 'border-border bg-muted/30 text-muted-foreground'
            : selected
              ? 'border-primary/70 ring-1 ring-primary/40 bg-primary/5'
              : 'border-border hover:border-border/80',
        !canSelect && 'cursor-default',
        setupStatus.kind === 'checking' && 'border-border bg-card/80'
      )}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span
          className={cn(
            'bg-background/60 border-border grid size-11 place-items-center rounded-lg border',
            isConnected && 'border-green-500/30 bg-green-500/10',
            isUnavailable && 'bg-muted/40'
          )}
        >
          <Icon className="size-6" />
        </span>
        <SetupStatusBadge status={setupStatus} selected={selected && canSelect} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-muted-foreground text-xs font-medium">{option.connectionType}</span>
        <span className="text-base font-medium">{option.name}</span>
        <span className="text-muted-foreground text-sm leading-relaxed">{option.description}</span>
        {setupDetail && (
          <span id={detailId} className="w-full break-words text-xs leading-relaxed text-green-400">
            Connected to {setupDetail}
          </span>
        )}
        {setupStatus.kind === 'unavailable' && (
          <span id={detailId} className="text-muted-foreground text-xs leading-relaxed">
            Setup is not available from this wizard yet.
          </span>
        )}
        {setupStatus.kind === 'unknown' && (
          <span id={detailId} className="text-muted-foreground text-xs leading-relaxed">
            Status check failed. You can still try authorization.
          </span>
        )}
      </span>
    </button>
  );
}

function SetupStatusBadge({
  status,
  selected,
}: {
  status: PlatformSetupStatus;
  selected: boolean;
}) {
  if (status.kind === 'connected') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2 py-1 text-xs font-medium text-green-400">
        <Check className="size-3" strokeWidth={3} aria-hidden="true" />
        {status.label}
      </span>
    );
  }

  if (status.kind === 'checking') {
    return (
      <span
        className="text-muted-foreground inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2 py-1 text-xs font-medium"
        aria-live="polite"
      >
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        {status.label}
      </span>
    );
  }

  if (status.kind === 'unavailable') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2 py-1 text-xs font-medium">
        <Clock3 className="size-3" aria-hidden="true" />
        {status.label}
      </span>
    );
  }

  if (status.kind === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-xs font-medium text-yellow-300">
        <AlertCircle className="size-3" aria-hidden="true" />
        {status.label}
      </span>
    );
  }

  if (selected) {
    return (
      <span
        aria-hidden="true"
        className="bg-primary text-primary-foreground grid size-5 place-items-center rounded-full"
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="grid size-5 place-items-center rounded-full opacity-0 transition-opacity duration-150"
    >
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}
