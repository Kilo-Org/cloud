'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import Link from 'next/link';
import { toast } from 'sonner';
import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { humanizeToken, parseHistoricalDeletionUserIds } from './deletion-queue-format';

type HistoricalResults =
  inferRouterOutputs<RootRouter>['admin']['userDeletionQueue']['previewHistoricalUsers'];

const REFUSAL_LABELS: Record<string, string> = {
  active_admin_required: 'An active administrator is required.',
  user_not_found: 'User ID not found.',
  not_canonical_soft_deleted_user: 'This is not a recognized soft-deleted account.',
  protected_bot: 'Bot accounts are excluded.',
  invalid_deletion_timestamp: 'The original deletion date could not be verified.',
  active_deletion_request: 'Another deletion request is already active.',
  live_subscription: 'Cancel the live subscription before queueing cleanup.',
};

function resultLabel(result: HistoricalResults[number]): string {
  switch (result.status) {
    case 'eligible':
      return 'Ready to queue';
    case 'enqueued':
      return 'Queued';
    case 'existing':
      return `Existing request: ${humanizeToken(result.requestStatus).toLowerCase()}`;
    case 'refused':
      return REFUSAL_LABELS[result.code] ?? humanizeToken(result.code);
    case 'failed':
      return 'Could not confirm the result. Preview again to retry safely.';
  }
}

export function HistoricalUserIdsForm({
  onSubmitted,
  onSubmittingChange,
}: {
  onSubmitted: () => void;
  onSubmittingChange: (submitting: boolean) => void;
}) {
  const trpc = useTRPC();
  const [text, setText] = useState('');
  const [results, setResults] = useState<HistoricalResults | null>(null);
  const userIds = useMemo(() => parseHistoricalDeletionUserIds(text), [text]);
  const preview = useMutation(
    trpc.admin.userDeletionQueue.previewHistoricalUsers.mutationOptions()
  );
  const submit = useMutation(trpc.admin.userDeletionQueue.submitHistoricalUsers.mutationOptions());
  const busy = preview.isPending || submit.isPending;
  const eligibleIds =
    results?.filter(result => result.status === 'eligible').map(result => result.userId) ?? [];
  const inputError =
    userIds.length > 100
      ? 'Paste no more than 100 unique user IDs at a time.'
      : userIds.some(userId => userId.length > 1024)
        ? 'Each user ID must be at most 1,024 characters.'
        : null;
  const error = inputError ?? preview.error?.message ?? submit.error?.message;

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertTitle>User-ID cleanup only — no notifications</AlertTitle>
        <AlertDescription>
          Runs KiloClaw teardown, CLI v1/v2 deletion, usage-prompt cleanup, and Cloud anonymization
          for soft-deleted accounts. PostHog persons, events, and recordings are deleted only on an
          exact user-ID match. PostHog is skipped if no person matches. Email-based provider lookups
          are excluded. No email or Pylon reply will be sent.
        </AlertDescription>
      </Alert>
      <div className="flex flex-col gap-2">
        <Label htmlFor="historical-deletion-user-ids">User IDs</Label>
        <Textarea
          id="historical-deletion-user-ids"
          value={text}
          onChange={event => {
            setText(event.target.value);
            setResults(null);
            preview.reset();
            submit.reset();
          }}
          disabled={busy}
          aria-describedby="historical-deletion-help historical-deletion-error"
          aria-invalid={Boolean(error)}
          className="min-h-36 font-mono"
          placeholder="One user ID per line"
        />
        <p id="historical-deletion-help" className="text-muted-foreground text-xs">
          Up to 100 IDs. Duplicate lines are ignored; IDs remain case-sensitive.
        </p>
        <p id="historical-deletion-error" className="text-destructive text-sm" role="alert">
          {error}
        </p>
      </div>
      <div aria-live="polite" aria-busy={busy}>
        {preview.isPending ? (
          <p className="text-muted-foreground text-sm">Checking user IDs…</p>
        ) : null}
        {results ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">
              {submit.isSuccess
                ? 'Queue results'
                : `Ready to queue: ${eligibleIds.length} of ${results.length}`}
            </p>
            <ul className="max-h-52 space-y-2 overflow-y-auto">
              {results.map(result => (
                <li key={result.userId} className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs break-all">{result.userId}</span>
                  <span
                    className={
                      result.status === 'refused' || result.status === 'failed'
                        ? 'text-status-warning'
                        : 'text-muted-foreground'
                    }
                  >
                    {resultLabel(result)}
                  </span>
                  {'requestId' in result && result.requestId ? (
                    <Link
                      href={`/admin/deletion-queue/${encodeURIComponent(result.requestId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link hover:text-link-hover text-xs underline"
                    >
                      View request
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        Confirming permanently removes remaining data. Enqueued cleanup cannot be cancelled.
      </p>
      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant={eligibleIds.length > 0 ? 'secondary' : 'default'}
          disabled={busy || userIds.length === 0 || Boolean(inputError)}
          onClick={async () => {
            setResults(null);
            submit.reset();
            try {
              setResults(await preview.mutateAsync({ userIds }));
            } catch {
              setResults(null);
            }
          }}
        >
          {preview.isPending ? 'Checking…' : 'Preview user IDs'}
        </Button>
        <Button
          type="button"
          disabled={busy || eligibleIds.length === 0 || Boolean(inputError)}
          onClick={async () => {
            onSubmittingChange(true);
            try {
              const outcomes = await submit.mutateAsync({ userIds: eligibleIds });
              const allResults =
                results?.map(
                  result => outcomes.find(outcome => outcome.userId === result.userId) ?? result
                ) ?? outcomes;
              setResults(allResults);
              onSubmitted();
              if (
                allResults.some(result => result.status === 'refused' || result.status === 'failed')
              ) {
                toast.error('Some users could not be queued. Review the results.');
              } else {
                const queued = outcomes.filter(result => result.status === 'enqueued').length;
                toast.success(`${queued} requests queued. No notifications will be sent.`);
              }
            } catch {
              setResults(null);
            } finally {
              onSubmittingChange(false);
            }
          }}
        >
          {submit.isPending ? 'Queueing…' : 'Confirm ID-only cleanup'}
        </Button>
      </DialogFooter>
    </div>
  );
}
