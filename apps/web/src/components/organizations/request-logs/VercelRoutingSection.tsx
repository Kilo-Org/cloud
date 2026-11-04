import { ArrowRight, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  RequestLogInferenceRegion,
  RequestLogPlannedProvider,
  RequestLogVercelAttempt,
  RequestLogVercelRouting,
} from '@/lib/request-logs/routing-details';
import { DetailGrid, DetailSection, TONE_CLASSNAMES, ToneBadge } from './detail-primitives';
import { formatDurationMs } from './format';

export function formatInferenceRegion(region: RequestLogInferenceRegion): string | null {
  const parts = [region.provider_region, region.geo_region?.toUpperCase()].filter(
    part => part != null && part !== ''
  );
  if (parts.length > 0) return [...new Set(parts)].join(' · ');
  return region.slug;
}

function plannedProviderState(
  planned: RequestLogPlannedProvider,
  attempts: RequestLogVercelAttempt[]
): 'succeeded' | 'failed' | 'not-attempted' {
  const credential = planned.credential.toLowerCase();
  const attempt = attempts.find(
    candidate =>
      candidate.provider === planned.provider &&
      (candidate.credential_type === null || candidate.credential_type.toLowerCase() === credential)
  );
  if (!attempt) return 'not-attempted';
  return attempt.success ? 'succeeded' : 'failed';
}

const PLANNED_STATE_CLASSNAMES = {
  succeeded: TONE_CLASSNAMES.selected,
  failed: TONE_CLASSNAMES.rejected,
  'not-attempted': 'border-border text-muted-foreground border-dashed',
} as const;

const PLANNED_STATE_LABELS = {
  succeeded: 'served the request',
  failed: 'failed',
  'not-attempted': 'not attempted',
} as const;

function ExecutionPlan({ routing }: { routing: RequestLogVercelRouting }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Vercel AI Gateway plan">
      {routing.execution_order.map((planned, index) => {
        const state = plannedProviderState(planned, routing.attempts);
        return (
          <li
            key={`${planned.provider}-${planned.credential}`}
            className="flex items-center gap-1.5"
          >
            {index > 0 && (
              <ArrowRight aria-hidden="true" className="text-muted-foreground size-3.5" />
            )}
            <span
              className={cn(
                'rounded-md border px-2 py-1 font-mono text-xs',
                PLANNED_STATE_CLASSNAMES[state]
              )}
              title={`${planned.provider} (${planned.credential}) ${PLANNED_STATE_LABELS[state]}`}
            >
              {planned.provider}
              <span className="opacity-70"> · {planned.credential}</span>
              <span className="sr-only">, {PLANNED_STATE_LABELS[state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Attempts({ attempts }: { attempts: RequestLogVercelAttempt[] }) {
  return (
    <ol className="flex flex-col gap-2" aria-label="Provider attempts">
      {attempts.map((attempt, index) => {
        const region = attempt.region ? formatInferenceRegion(attempt.region) : null;
        return (
          <li
            key={`${attempt.provider}-${index}`}
            className="flex flex-col gap-1 rounded-md border p-2.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs tabular-nums">#{index + 1}</span>
              <span className="font-mono text-xs">{attempt.provider}</span>
              {attempt.credential_type && (
                <span className="text-muted-foreground text-xs">{attempt.credential_type}</span>
              )}
              <ToneBadge tone={attempt.success === false ? 'rejected' : 'selected'}>
                {attempt.success === false ? 'Failed' : 'Succeeded'}
                {attempt.status_code !== null && ` · ${attempt.status_code}`}
              </ToneBadge>
              <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                {formatDurationMs(attempt.duration_ms)}
              </span>
            </div>
            {(region || attempt.model) && (
              <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {attempt.model && <span className="font-mono">{attempt.model}</span>}
                {region && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin aria-hidden="true" className="size-3" />
                    {region}
                  </span>
                )}
              </div>
            )}
            {attempt.error && <p className="text-status-destructive text-xs">{attempt.error}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export function VercelRoutingSection({ routing }: { routing: RequestLogVercelRouting }) {
  const finalAttempt =
    routing.attempts.findLast(attempt => attempt.success === true) ?? routing.attempts.at(-1);
  const finalRegion = finalAttempt?.region ? formatInferenceRegion(finalAttempt.region) : null;

  return (
    <DetailSection
      title="Vercel AI Gateway"
      description="How the Vercel AI Gateway picked the upstream provider for this request."
    >
      <DetailGrid
        items={[
          { label: 'Final provider', value: routing.final_provider ?? '—', mono: true },
          {
            label: 'Inference region',
            value: finalRegion ?? 'Not reported',
            mono: finalRegion !== null,
          },
          {
            label: 'Vercel credential type',
            value: finalAttempt?.credential_type ?? '—',
          },
          { label: 'Model', value: routing.original_model ?? '—', mono: true },
          {
            label: 'Session affinity',
            value: routing.affinity?.outcome?.replaceAll('_', ' ') ?? '—',
          },
        ]}
      />
      {routing.execution_order.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Plan</span>
          <ExecutionPlan routing={routing} />
        </div>
      )}
      {routing.attempts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Attempts</span>
          <Attempts attempts={routing.attempts} />
        </div>
      )}
      {routing.generation_id && (
        <p className="text-muted-foreground text-xs">
          Generation ID: <span className="font-mono">{routing.generation_id}</span>
        </p>
      )}
    </DetailSection>
  );
}
