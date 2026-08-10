import React from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { RecoveryActionGate } from './data-export-recovery';

/**
 * Pure presentational pieces for the manual intervention card. Container logic
 * (tRPC mutations, routing, toasts) lives in DataExportRecoveryCard.tsx so these
 * stay renderable without providers.
 */

export function RecoveryActionItem({
  title,
  description,
  actionLabel,
  pendingLabel,
  icon,
  variant,
  gate,
  isPending,
  anyPending,
  onSelect,
}: {
  title: string;
  description: string;
  actionLabel: string;
  pendingLabel: string;
  icon: React.ReactNode;
  variant: 'outline' | 'destructive';
  gate: RecoveryActionGate;
  isPending: boolean;
  /** True while any recovery mutation is in flight; disables competing actions. */
  anyPending: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="flex flex-col items-start gap-2">
        <Button
          variant={variant}
          className="h-11 w-full sm:h-9 sm:w-auto"
          disabled={gate.disabled || anyPending}
          onClick={onSelect}
        >
          {isPending ? <Loader2 className="animate-spin" /> : icon}
          {isPending ? pendingLabel : actionLabel}
        </Button>
        {gate.reason ? (
          <p role="status" className="text-status-warning text-sm break-words">
            {gate.reason}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Visible export ID plus the exact-match typed confirmation input. */
export function ExportIdConfirmationField({
  id,
  exportId,
  value,
  disabled,
  onChange,
}: {
  id: string;
  exportId: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Type the full export ID to confirm</Label>
      <code className="bg-muted/50 w-fit max-w-full rounded-md px-2 py-1 font-mono text-xs break-all">
        {exportId}
      </code>
      <Input
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={exportId}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="font-mono text-xs"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        The ID must match exactly, including capitalization.
      </p>
    </div>
  );
}

export function RedispatchConsequences() {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>Restarts this export from the beginning with a new fenced dispatch generation.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Legacy cursor and part state is discarded.</li>
        <li>Any interrupted multipart upload is aborted before the new run starts.</li>
        <li>The original snapshot and export ID are preserved.</li>
      </ul>
    </div>
  );
}

export function PurgeConsequences() {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>Permanently removes this export without a replacement. This cannot be undone.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Deletes the control-plane record, including execution state and outbox history.</li>
        <li>Queues deletion of the stored artifact and any open multipart upload.</li>
        <li>No replacement export is created; the user may request another export immediately.</li>
        <li>An existing signed download URL may keep working for up to 5 minutes.</li>
      </ul>
    </div>
  );
}

export function RetryConsequences() {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>Replaces this export with a fresh one generated from the same snapshot.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Removes this export and its history, and queues artifact cleanup.</li>
        <li>Creates a new export with a new export ID from the same snapshot.</li>
        <li>The user&apos;s 24-hour request limit is bypassed.</li>
      </ul>
    </div>
  );
}

/** Inline destructive alert for a failed recovery mutation; the message is server-redacted. */
export function RecoveryErrorAlert({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="break-words">{message}</AlertDescription>
    </Alert>
  );
}
