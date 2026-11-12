import { getByokProviderDisplayName } from '@/lib/byok/provider-names';
import type { RequestLogByokFailoverAttempt } from '@/lib/request-logs/routing-details';
import { DetailSection, ToneBadge } from './detail-primitives';
import { formatDurationMs } from './format';
import type { StepTone } from './routing-labels';

const OUTCOMES: Record<string, { label: string; tone: StepTone }> = {
  'failed-over': { label: 'Failed, tried next key', tone: 'rejected' },
  served: { label: 'Served', tone: 'selected' },
  failed: { label: 'Failed', tone: 'rejected' },
};

function outcomeOf(outcome: string) {
  return Object.hasOwn(OUTCOMES, outcome)
    ? OUTCOMES[outcome]
    : { label: outcome, tone: 'info' as const };
}

function keyName(attempt: RequestLogByokFailoverAttempt): string {
  return attempt.byok_provider_ids.length > 0
    ? attempt.byok_provider_ids.map(getByokProviderDisplayName).join(', ')
    : 'BYOK key';
}

/** A provider key sent through Kilo's Vercel AI Gateway route; the user's own gateway key is the gateway. */
function isThroughVercel(attempt: RequestLogByokFailoverAttempt): boolean {
  return (
    attempt.provider_type === 'vercel' && !attempt.byok_provider_ids.includes('vercel-ai-gateway')
  );
}

export function ByokFailoverSection({ attempts }: { attempts: RequestLogByokFailoverAttempt[] }) {
  return (
    <DetailSection
      title="BYOK failover"
      description="The upstream provider returned an error, so Kilo retried with the next BYOK key in route order. Failover never uses Kilo credits."
    >
      <ol className="flex flex-col gap-1 rounded-md border p-2" aria-label="BYOK failover attempts">
        {attempts.map((attempt, index) => {
          const outcome = outcomeOf(attempt.outcome);
          return (
            <li
              key={`${attempt.byok_provider_ids.join('-')}-${index}`}
              className="flex items-start gap-2 text-xs"
            >
              <span className="text-muted-foreground w-5 shrink-0 pt-0.5 text-right tabular-nums">
                {index + 1}.
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{keyName(attempt)}</span>
                {isThroughVercel(attempt) && (
                  <span className="text-muted-foreground">via Vercel AI Gateway</span>
                )}
                <ToneBadge tone={outcome.tone}>{outcome.label}</ToneBadge>
                {attempt.status !== undefined && (
                  <span className="font-mono tabular-nums">HTTP {attempt.status}</span>
                )}
                {attempt.error_code && (
                  <span className="text-muted-foreground font-mono break-all">
                    {attempt.error_code}
                  </span>
                )}
              </div>
              <span className="text-muted-foreground shrink-0 pt-0.5 tabular-nums">
                {formatDurationMs(attempt.duration_ms ?? null)}
              </span>
            </li>
          );
        })}
      </ol>
    </DetailSection>
  );
}
