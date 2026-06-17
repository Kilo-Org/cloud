'use client';

import { useState, type ReactNode } from 'react';
import { Brain, GitPullRequest, Info, Package, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type Tone = 'success' | 'warning' | 'destructive' | 'neutral';

export type StatusValue = {
  value: string;
  tone: Tone;
};

export type FindingHeaderData = {
  title: string;
  repository: string;
  detectedAt: string;
  activityLabel: string;
  severity: StatusValue;
  finding: StatusValue;
  analysis: StatusValue;
};

export const lodashFindingIdentity = {
  title: 'Command Injection in lodash',
  repository: 'Kilo-Org/security-agent-testbed',
  detectedAt: 'Mar 4, 2026',
  severity: { value: 'High', tone: 'warning' },
} satisfies Pick<FindingHeaderData, 'title' | 'repository' | 'detectedAt' | 'severity'>;

export const toneStyles: Record<
  Tone,
  { status: string; icon: string; text: string; step: string; border: string }
> = {
  success: {
    status: 'border-status-success-border bg-status-success-surface text-status-success',
    icon: 'bg-status-success-surface text-status-success-icon ring-status-success-border',
    text: 'text-status-success',
    step: 'bg-status-success-surface text-status-success ring-status-success-border',
    border: 'border-status-success-border bg-status-success-surface',
  },
  warning: {
    status: 'border-status-warning-border bg-status-warning-surface text-status-warning',
    icon: 'bg-status-warning-surface text-status-warning-icon ring-status-warning-border',
    text: 'text-status-warning',
    step: 'bg-status-warning-surface text-status-warning ring-status-warning-border',
    border: 'border-status-warning-border bg-status-warning-surface',
  },
  destructive: {
    status:
      'border-status-destructive-border bg-status-destructive-surface text-status-destructive',
    icon: 'bg-status-destructive-surface text-status-destructive-icon ring-status-destructive-border',
    text: 'text-status-destructive',
    step: 'bg-status-destructive-surface text-status-destructive ring-status-destructive-border',
    border: 'border-status-destructive-border bg-status-destructive-surface',
  },
  neutral: {
    status: 'border-status-neutral-border bg-status-neutral-surface text-status-neutral',
    icon: 'bg-status-neutral-surface text-status-neutral-icon ring-status-neutral-border',
    text: 'text-status-neutral',
    step: 'bg-status-neutral-surface text-status-neutral-icon ring-status-neutral-border',
    border: 'border-status-neutral-border bg-surface-inset',
  },
};

const tabs: { label: string; icon: LucideIcon }[] = [
  { label: 'Details', icon: Package },
  { label: 'Analysis', icon: Brain },
  { label: 'Remediation', icon: GitPullRequest },
];

export function FindingPreview({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="bg-surface-background text-foreground min-h-screen px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex max-w-3xl flex-col gap-2">
          <div className="text-muted-foreground type-eyebrow">{eyebrow}</div>
          <h1 className="type-title">{title}</h1>
          <p className="text-muted-foreground type-body max-w-[70ch]">{description}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

export function FindingDialogShell({
  header,
  selectedTab,
  children,
}: {
  header: FindingHeaderData;
  selectedTab: 'Details' | 'Analysis' | 'Remediation';
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const statuses = [
    { label: 'Severity', ...header.severity },
    { label: 'Finding', ...header.finding },
    { label: 'Analysis', ...header.analysis },
  ];

  if (!isOpen) {
    return (
      <output className="border-border bg-surface-raised text-muted-foreground type-body mx-auto block rounded-xl border p-6">
        Finding preview closed.
      </output>
    );
  }

  return (
    <article className="border-border bg-surface-raised mx-auto overflow-hidden rounded-xl border">
      <header className="border-border border-b px-4 pt-5 sm:px-6 sm:pt-6">
        <div className="relative">
          <div className="min-w-0">
            <h2 className="type-title min-h-control-touch pr-14">{header.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <code className="bg-surface-inset text-syntax-plain type-code max-w-full break-words rounded-sm px-1.5 py-0.5">
                {header.repository}
              </code>
              <span className="text-muted-foreground type-code tabular-nums">
                Detected {header.detectedAt}
              </span>
              <span className="text-muted-foreground type-code tabular-nums">
                {header.activityLabel}
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-control-touch absolute top-0 right-0"
            aria-label="Close finding preview"
            onClick={() => setIsOpen(false)}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {statuses.map(status => (
            <LabeledStatus
              key={status.label}
              label={status.label}
              value={status.value}
              tone={status.tone}
            />
          ))}
        </div>

        <nav aria-label="Finding detail sections" className="mt-5 pb-3">
          <div className="border-border bg-surface-raised flex h-auto w-full gap-1 rounded-xl border p-1.5 shadow-sm">
            {tabs.map(tab => {
              const Icon = tab.icon;
              const selected = tab.label === selectedTab;
              return (
                <div
                  key={tab.label}
                  aria-current={selected ? 'page' : undefined}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-sm font-medium whitespace-nowrap sm:gap-2 sm:px-3 ${
                    selected
                      ? 'border-border-strong bg-surface-selected text-foreground shadow-sm'
                      : 'text-muted-foreground border-transparent'
                  }`}
                >
                  <Icon className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
                  <span>{tab.label}</span>
                </div>
              );
            })}
          </div>
        </nav>
      </header>

      <div className="px-4 py-5 sm:px-6 sm:py-6">{children}</div>
    </article>
  );
}

export function FindingOutcome({
  title,
  description,
  icon: Icon,
  tone,
  spinning = false,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  tone: Tone;
  spinning?: boolean;
}) {
  return (
    <section className="flex gap-3 sm:gap-4">
      <div
        className={`mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full ring-1 ${toneStyles[tone].icon}`}
      >
        <Icon
          className={`size-5 ${spinning ? 'animate-spin motion-reduce:animate-none' : ''}`}
          aria-hidden="true"
        />
      </div>
      <div className="min-w-0">
        <h3 className="type-heading">{title}</h3>
        <p className="text-muted-foreground type-body mt-1 max-w-[68ch]">{description}</p>
      </div>
    </section>
  );
}

export function FindingActionSection({
  label,
  title,
  description,
  children,
}: {
  label: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="border-border grid gap-4 border-t pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div>
        <div className="text-muted-foreground type-label">{label}</div>
        <h4 className="type-body mt-1.5 font-medium">{title}</h4>
        <p className="text-muted-foreground type-body mt-1 max-w-[62ch]">{description}</p>
      </div>
      {children && <div className="flex flex-wrap gap-2 sm:justify-end">{children}</div>}
    </section>
  );
}

export function FindingContextNote({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground type-label flex max-w-[70ch] items-start gap-2">
      <Info className="size-icon-sm mt-0.5 shrink-0" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

function LabeledStatus({ label, value, tone }: StatusValue & { label: string }) {
  return (
    <div className={`type-label flex items-center rounded-full border ${toneStyles[tone].status}`}>
      <span className="border-status-neutral-border text-muted-foreground px-status border-r py-1">
        {label}
      </span>
      <span className="px-status py-1">{value}</span>
    </div>
  );
}
