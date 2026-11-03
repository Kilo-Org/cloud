import { Fragment, type ReactNode } from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import type {
  PreferredProviderOrderConfig,
  PreferredProviderOrderRule,
} from '@kilocode/db/schema-types';
import { cn } from '@/lib/utils';

const ROW_GRID = 'grid grid-cols-[2rem_minmax(0,1fr)_1rem_minmax(0,1fr)] items-center gap-3';

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'bg-muted text-foreground rounded border px-1.5 py-0.5 font-mono text-xs',
        className
      )}
    >
      {children}
    </code>
  );
}

function RuleCondition({ rule }: { rule: PreferredProviderOrderRule }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {rule.includes.map((substring, index) => (
        <Fragment key={substring}>
          {index > 0 && <span className="text-muted-foreground text-xs">or</span>}
          <Chip>{substring}</Chip>
        </Fragment>
      ))}
      {rule.excludes && rule.excludes.length > 0 && (
        <>
          <span className="text-muted-foreground text-xs">but not</span>
          {rule.excludes.map(substring => (
            <Chip
              key={substring}
              className="border-status-destructive-border bg-status-destructive-surface text-status-destructive"
            >
              {substring}
            </Chip>
          ))}
        </>
      )}
    </div>
  );
}

function ProviderChain({ providers }: { providers: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {providers.map((provider, index) => (
        <Fragment key={provider}>
          {index > 0 && (
            <>
              <ChevronRight className="text-muted-foreground size-3" aria-hidden />
              <span className="sr-only">then</span>
            </>
          )}
          <Chip className={index === 0 ? 'border-foreground/40' : undefined}>{provider}</Chip>
        </Fragment>
      ))}
    </div>
  );
}

function RoutingRow({
  step,
  matched,
  dimmed,
  condition,
  target,
}: {
  step: number | null;
  matched: boolean;
  dimmed: boolean;
  condition: ReactNode;
  target: ReactNode;
}) {
  return (
    <li
      className={cn(
        ROW_GRID,
        'rounded-md border px-3 py-2 transition-opacity',
        matched && 'border-ring bg-accent',
        dimmed && 'opacity-50'
      )}
      aria-current={matched ? 'true' : undefined}
    >
      <span className="text-muted-foreground font-mono text-xs tabular-nums">{step ?? '—'}</span>
      {condition}
      <ArrowRight className="text-muted-foreground size-4" aria-hidden />
      <div>
        <span className="sr-only">routes to</span>
        {target}
      </div>
    </li>
  );
}

/**
 * Renders the rules as a top-to-bottom routing table. `matchedRuleIndex` is
 * null when no model is being previewed, and -1 when the preview matches no rule.
 */
export function ProviderOrderRoutingDiagram({
  config,
  matchedRuleIndex,
}: {
  config: PreferredProviderOrderConfig;
  matchedRuleIndex: number | null;
}) {
  const previewing = matchedRuleIndex !== null;

  return (
    <div className="flex flex-col gap-2">
      <div className={cn(ROW_GRID, 'text-muted-foreground px-3 text-xs font-medium')} aria-hidden>
        <span>#</span>
        <span>Model ID contains</span>
        <span />
        <span>Provider order</span>
      </div>
      <ol className="flex flex-col gap-2" aria-label="Provider order rules, checked top to bottom">
        {config.rules.map((rule, index) => (
          <RoutingRow
            key={index}
            step={index + 1}
            matched={matchedRuleIndex === index}
            dimmed={previewing && matchedRuleIndex !== index}
            condition={<RuleCondition rule={rule} />}
            target={<ProviderChain providers={rule.providers} />}
          />
        ))}
        <RoutingRow
          step={null}
          matched={matchedRuleIndex === -1}
          dimmed={previewing && matchedRuleIndex !== -1}
          condition={<span className="text-muted-foreground text-sm">Any other model</span>}
          target={<span className="text-muted-foreground text-sm">No preference</span>}
        />
      </ol>
    </div>
  );
}
