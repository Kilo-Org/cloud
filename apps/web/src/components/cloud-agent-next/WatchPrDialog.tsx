'use client';

import { useId, useState } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';
import type { AssociatedPr } from './utils/github-pr-link';
import {
  canEnablePrWatch,
  validWatchPrPreferences,
  watchPrObservationLabel,
  watchPrProblemLabels,
  watchPrMatchesIdentity,
  watchPrQueryInput,
} from './utils/watch-pr-view';

type WatchPrDialogProps = { sessionId: string; pr: AssociatedPr };

export function WatchPrDialog({ sessionId, pr }: WatchPrDialogProps) {
  return (
    <WatchPrDialogContent
      key={JSON.stringify([sessionId, pr.url, pr.number])}
      sessionId={sessionId}
      pr={pr}
    />
  );
}

function WatchPrDialogContent({ sessionId, pr }: WatchPrDialogProps) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState('');
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [perProblem, setPerProblem] = useState(2);
  const [total, setTotal] = useState(10);
  const [categories, setCategories] = useState({
    reviews: true,
    failedChecks: true,
    baseUpdates: true,
  });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryInput = watchPrQueryInput(sessionId, pr);
  const options = useQuery({
    ...trpc.cliSessionsV2.getPrWatchOptions.queryOptions(queryInput ?? skipToken),
    enabled: open,
  });
  const summary = useQuery({
    ...trpc.cliSessionsV2.getWatchPr.queryOptions(queryInput ?? skipToken),
    enabled: open,
  });
  const identityError =
    !queryInput || (summary.data && !watchPrMatchesIdentity(summary.data, queryInput))
      ? 'PR identity changed; refresh the PR badge before retrying'
      : null;
  const watch = identityError ? null : summary.data;
  const selectedIntegration = integrationId ?? options.data?.defaultIntegrationId ?? '';
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.cliSessionsV2.getWatchPr.queryFilter({ sessionId })),
      queryClient.invalidateQueries(
        trpc.cliSessionsV2.getPrWatchOptions.queryFilter({ sessionId })
      ),
      queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter()),
    ]);
  };
  const callbacks = {
    onSuccess: async () => {
      setError(null);
      setConsent(false);
      await invalidate();
    },
    onError: (failure: { message: string }) => {
      setError(failure.message);
      void invalidate();
    },
  };
  const enable = useMutation({
    ...trpc.cliSessionsV2.enableWatchPr.mutationOptions(),
    ...callbacks,
  });
  const pause = useMutation({ ...trpc.cliSessionsV2.pauseWatchPr.mutationOptions(), ...callbacks });
  const resume = useMutation({
    ...trpc.cliSessionsV2.resumeWatchPr.mutationOptions(),
    ...callbacks,
  });
  const stop = useMutation({ ...trpc.cliSessionsV2.stopWatchPr.mutationOptions(), ...callbacks });
  const recheck = useMutation({
    ...trpc.cliSessionsV2.recheckWatchPr.mutationOptions(),
    ...callbacks,
  });
  const busy =
    enable.isPending || pause.isPending || resume.isPending || stop.isPending || recheck.isPending;
  const fresh = !watch || watch.status === 'finished';
  const eligible = canEnablePrWatch(
    pr,
    options.data?.canEnable === true && !options.error && !summary.error && !identityError
  );
  const canSubmit =
    eligible &&
    consent &&
    options.data?.integrationOptions.some(option => option.integrationId === selectedIntegration) &&
    validWatchPrPreferences(model, hours, perProblem, total);
  const mutationInput = watch ? { watchId: watch.id, generation: watch.generation } : null;
  const retry = () => {
    setError(null);
    void options.refetch();
    void summary.refetch();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        setOpen(nextOpen);
        if (!nextOpen) setConsent(false);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Watch PR #${pr.number}`}
          title="Watch PR"
          onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
        >
          <Eye aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Watch PR #{pr.number}</DialogTitle>
          <DialogDescription>
            Observation only. No automatic repairs, agent runs, edits, or pushes.
          </DialogDescription>
        </DialogHeader>
        <div className="text-muted-foreground space-y-2 text-xs">
          <p>
            Observes future GitHub webhook events only. Existing reviews and check failures may be
            missing. This is not a merge-readiness assessment.
          </p>
          <p>No compute is kept idle and this milestone incurs no agent usage charges.</p>
        </div>

        {(identityError || options.error || summary.error || error) && (
          <div
            role="alert"
            className="border-destructive/50 space-y-2 rounded-md border p-3 text-sm break-words"
          >
            <p>{identityError ?? error ?? summary.error?.message ?? options.error?.message}</p>
            <Button variant="outline" size="sm" onClick={retry} disabled={busy}>
              Refresh and retry
            </Button>
          </div>
        )}
        {summary.isPending && (
          <p role="status" className="text-muted-foreground text-sm">
            Loading watch...
          </p>
        )}
        {watch && (
          <section aria-label="Watch status" className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>
                {watch.status === 'finished'
                  ? 'Finished'
                  : watch.status === 'paused'
                    ? 'Paused'
                    : 'Watching'}
              </strong>
              <span className="text-muted-foreground text-xs">Observation only</span>
            </div>
            {watch.lifecycle_reason && (
              <p className="text-muted-foreground break-words">
                {watch.lifecycle_reason.replaceAll('_', ' ')}
              </p>
            )}
            <p>{watchPrObservationLabel(watch.projection)}</p>
            <p className="text-muted-foreground text-xs">
              Last relevant event:{' '}
              {watch.last_event_at ? (
                <time dateTime={watch.last_event_at}>
                  {new Date(watch.last_event_at).toLocaleString()}
                </time>
              ) : (
                'None received'
              )}
              <br />
              Expires:{' '}
              <time dateTime={watch.expires_at}>{new Date(watch.expires_at).toLocaleString()}</time>
            </p>
            {watch.projection.ambiguous && (
              <p>Some observations have uncertain ordering. Verify on GitHub.</p>
            )}
            {watch.projection.truncated && (
              <p>Observation history is limited; some evidence is missing.</p>
            )}
            {watch.projection.needsAttention && (
              <p>Observations need manual attention. No repair will run.</p>
            )}
            {watch.projection.pending.length > 0 && (
              <div>
                <h3 className="mb-1 font-medium">
                  Pending observed problems ({watch.projection.pending.length})
                </h3>
                <ul className="text-muted-foreground list-inside list-disc space-y-1">
                  {watch.projection.pending.slice(0, 10).map(problem => (
                    <li key={problem.key}>{watchPrProblemLabels[problem.reason]}</li>
                  ))}
                </ul>
                {watch.projection.pending.length > 10 && (
                  <p className="text-muted-foreground text-xs">Showing the first 10 problems.</p>
                )}
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer">Saved preferences (unused)</summary>
              <p className="text-muted-foreground mt-2 break-words">
                Model: {watch.policy.model}. Profile: {watch.policy.profileId ?? 'None'}. Branch
                strategy: {watch.policy.branchStrategy}. Attempts:{' '}
                {watch.policy.maxAttemptsPerProblem} per problem, {watch.policy.maxTotalAttempts}{' '}
                total. These preferences do not authorize automatic writes now or later.
              </p>
            </details>
            {mutationInput && watch.status !== 'finished' && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {watch.status === 'watching' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || summary.isFetching}
                      onClick={() => pause.mutate(mutationInput)}
                    >
                      Pause
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || summary.isFetching || !options.data?.enabled}
                      onClick={() => resume.mutate(mutationInput)}
                    >
                      Resume
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || summary.isFetching || !watch.manualRecheckAvailable}
                    onClick={() => recheck.mutate(mutationInput)}
                  >
                    Recheck PR lifecycle
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || summary.isFetching}
                    onClick={() => stop.mutate(mutationInput)}
                  >
                    Stop watching
                  </Button>
                </div>
                {watch.status === 'paused' && options.data && !options.data.enabled && (
                  <p className="text-muted-foreground text-xs">
                    Resume is unavailable while enablement is disabled. You can still recheck or
                    stop.
                  </p>
                )}
                <p className="text-muted-foreground text-xs">
                  Recheck reads PR identity and open/closed/merged lifecycle only, not reviews or
                  checks. Pausing does not discard incoming observations.
                </p>
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer">
                Recent activity ({Math.min(watch.activity.length, 10)})
              </summary>
              {watch.activity.length === 0 ? (
                <p className="text-muted-foreground mt-2">No activity recorded.</p>
              ) : (
                <ol className="text-muted-foreground mt-2 space-y-2">
                  {watch.activity.slice(0, 10).map(item => (
                    <li key={item.id} className="break-words">
                      <span className="text-foreground">{item.kind.replaceAll('_', ' ')}</span>
                      {item.reason && `: ${item.reason.replaceAll('_', ' ')}`}
                      <br />
                      <time dateTime={item.created_at}>
                        {new Date(item.created_at).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
              <p className="text-muted-foreground mt-2">
                Limited history, showing up to 10 recent entries.
              </p>
            </details>
          </section>
        )}

        {fresh && summary.isSuccess && !identityError && (
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault();
              if (!canSubmit || busy || options.isFetching || !options.data || !queryInput) return;
              enable.mutate({
                ...queryInput,
                integrationId: selectedIntegration,
                expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
                policy: {
                  version: 1,
                  model: model.trim(),
                  profileId: options.data.defaults.profileId,
                  categories,
                  branchStrategy: 'merge',
                  historyRewriteConsent: false,
                  maxAttemptsPerProblem: perProblem,
                  maxTotalAttempts: total,
                  observationOnlyConsent: true,
                  futureEventsOnlyConsent: true,
                  noHardSpendCapConsent: true,
                },
              });
            }}
          >
            {!eligible && (
              <p className="text-muted-foreground text-sm">
                {options.isPending
                  ? 'Loading availability...'
                  : !canEnablePrWatch(pr, true)
                    ? 'Enabling requires a verified open GitHub PR. Refresh the PR badge if its status is unknown.'
                    : (options.data?.unavailableReason ?? 'Watch enablement is unavailable.')}
              </p>
            )}
            {eligible && (
              <fieldset disabled={busy || options.isFetching} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-connection`}>GitHub connection</Label>
                  <Select value={selectedIntegration} onValueChange={setIntegrationId}>
                    <SelectTrigger id={`${id}-connection`} className="w-full">
                      <SelectValue placeholder="Choose a connection" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.data?.integrationOptions.map(option => (
                        <SelectItem key={option.integrationId} value={option.integrationId}>
                          {option.accountLogin ?? 'GitHub connection'} ({option.appType})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-duration`}>Watch duration (hours, up to 24)</Label>
                  <Input
                    id={`${id}-duration`}
                    type="number"
                    min={1}
                    max={24}
                    step={1}
                    value={Number.isNaN(hours) ? '' : hours}
                    onChange={event => setHours(event.target.valueAsNumber)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-model`}>Saved model ID (unused preference)</Label>
                  <Input
                    id={`${id}-model`}
                    value={model}
                    onChange={event => setModel(event.target.value)}
                    maxLength={200}
                    required
                    aria-describedby={`${id}-preferences`}
                  />
                  <p id={`${id}-preferences`} className="text-muted-foreground text-xs">
                    No model runs in this milestone. Profile:{' '}
                    {options.data?.defaults.profileId ?? 'None'}. Merge-only branch preference.
                    These saved preferences cannot authorize automatic writes later without separate
                    consent.
                  </p>
                </div>
                <fieldset className="space-y-1">
                  <legend className="text-sm font-medium">
                    Saved categories (unused preferences)
                  </legend>
                  {(
                    [
                      { key: 'reviews', label: 'Review feedback' },
                      { key: 'failedChecks', label: 'Failed checks' },
                      { key: 'baseUpdates', label: 'Base updates' },
                    ] as const
                  ).map(category => (
                    <Label key={category.key} className="min-h-8 text-xs">
                      <Checkbox
                        checked={categories[category.key]}
                        onCheckedChange={checked =>
                          setCategories(current => ({ ...current, [category.key]: checked }))
                        }
                      />
                      {category.label}
                    </Label>
                  ))}
                </fieldset>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-per-problem`}>Attempts per problem (unused)</Label>
                    <Input
                      id={`${id}-per-problem`}
                      type="number"
                      min={1}
                      max={2}
                      step={1}
                      value={Number.isNaN(perProblem) ? '' : perProblem}
                      onChange={event => setPerProblem(event.target.valueAsNumber)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-total`}>Total attempts (unused)</Label>
                    <Input
                      id={`${id}-total`}
                      type="number"
                      min={perProblem}
                      max={10}
                      step={1}
                      value={Number.isNaN(total) ? '' : total}
                      onChange={event => setTotal(event.target.valueAsNumber)}
                      required
                    />
                  </div>
                </div>
                <Label className="items-start text-xs leading-relaxed">
                  <Checkbox
                    className="mt-1 shrink-0"
                    checked={consent}
                    onCheckedChange={setConsent}
                  />
                  I understand this is observation only, covers future webhook events only, and has
                  no hard per-watch spend cap. No automatic repairs or agent charges occur now;
                  future automatic writes require separate consent.
                </Label>
                <Button type="submit" disabled={!canSubmit || summary.isFetching}>
                  {enable.isPending ? 'Enabling...' : 'Enable observation-only watch'}
                </Button>
              </fieldset>
            )}
          </form>
        )}
        {busy && (
          <p role="status" className="text-muted-foreground text-xs">
            Updating watch...
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
