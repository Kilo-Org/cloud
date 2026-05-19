'use client';

import { Construction } from 'lucide-react';

type ComingSoonPlaceholderProps = {
  /** Page name shown in the empty-state title. Sentence case. */
  title: string;
  /** One-line description of what will live here. */
  description: string;
  /** Milestone tag (e.g. "M2.3") so reviewers can see the wiring. */
  milestone: string;
};

/**
 * Empty state used by the per-wasteland routes that haven't been
 * implemented yet (fork, pulls, settings). Keeps the nav clickable so
 * we can verify routing and layout without 404s.
 */
export function ComingSoonPlaceholder({
  title,
  description,
  milestone,
}: ComingSoonPlaceholderProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03]">
        <Construction className="size-5 text-white/40" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-white/80">{title}</p>
        <p className="max-w-sm text-xs text-white/40">{description}</p>
      </div>
      <span className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] tracking-wide text-white/40">
        {milestone}
      </span>
    </div>
  );
}
