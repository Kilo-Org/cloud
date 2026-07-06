'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { X } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useOnboardingTooltips, ONBOARDING_TOOLTIPS } from './useOnboardingTooltips';

// ── localStorage key for tracking whether first-task completion was detected ──
function firstTaskCompletedKey(townId: string) {
  return `gastown_onboarding_first_task_completed_${townId}`;
}

function wasFirstTaskCompleted(townId: string): boolean {
  try {
    return localStorage.getItem(firstTaskCompletedKey(townId)) === 'true';
  } catch {
    return false;
  }
}

function markFirstTaskCompleted(townId: string) {
  try {
    localStorage.setItem(firstTaskCompletedKey(townId), 'true');
  } catch {
    // localStorage unavailable
  }
}

// ── Main component ───────────────────────────────────────────────────────

type OnboardingTooltipsProps = {
  townId: string;
};

export function OnboardingTooltips({ townId }: OnboardingTooltipsProps) {
  const trpc = useGastownTRPC();
  const { activeTooltip, dismissCurrent, dismissAll, active, triggerTooltips } =
    useOnboardingTooltips(townId);

  // Check if first task was already completed previously
  const [alreadyCompleted] = useState(() => wasFirstTaskCompleted(townId));

  // Trigger tooltips immediately if first task was completed in a prior session
  useEffect(() => {
    if (alreadyCompleted) {
      triggerTooltips();
    }
  }, [alreadyCompleted, triggerTooltips]);

  // ── Detect first bead closure ────────────────────────────────────────
  // Query rigs, then beads per rig, to detect when any non-agent bead
  // transitions to closed status.
  //
  // needsPolling: only poll while we haven't yet detected a first-task
  // completion. Once tooltips are triggered (or were already completed in
  // a prior session), stop polling to avoid a permanent N+1 background hit.
  const [needsPolling, setNeedsPolling] = useState(!alreadyCompleted);

  const rigsQuery = useQuery({
    ...trpc.gastown.listRigs.queryOptions({ townId }),
    enabled: needsPolling,
  });
  const rigs = rigsQuery.data ?? [];

  const rigBeadQueries = useQueries({
    queries: rigs.map(rig => ({
      ...trpc.gastown.listBeads.queryOptions({ rigId: rig.id }),
      refetchInterval: needsPolling ? 8_000 : false,
    })),
  });

  const hasClosedBead = rigBeadQueries.some(q =>
    q.data?.some(b => b.type !== 'agent' && b.status === 'closed')
  );

  const triggeredRef = useRef(false);
  useEffect(() => {
    if (hasClosedBead && !triggeredRef.current && !alreadyCompleted) {
      triggeredRef.current = true;
      setNeedsPolling(false);
      markFirstTaskCompleted(townId);
      triggerTooltips();
    }
  }, [hasClosedBead, alreadyCompleted, townId, triggerTooltips]);

  if (!active || !activeTooltip) return null;

  return (
    <OnboardingTooltipPopover
      key={activeTooltip.id}
      tooltip={activeTooltip}
      onDismiss={dismissCurrent}
      onDismissAll={dismissAll}
    />
  );
}

// ── Individual tooltip popover ───────────────────────────────────────────

export function OnboardingTooltipPopover({
  tooltip,
  onDismiss,
  onDismissAll,
}: {
  tooltip: (typeof ONBOARDING_TOOLTIPS)[number];
  onDismiss: () => void;
  onDismissAll: () => void;
}) {
  const [anchorEl, setAnchorEl] = useState<Element | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Find the anchor element via its data attribute and track its rect so the
  // highlight ring stays aligned on scroll/resize. Radix repositions the
  // popover itself via the virtual anchor below.
  useEffect(() => {
    const findAnchor = () => {
      const el = document.querySelector(`[data-onboarding-target="${tooltip.target}"]`);
      setAnchorEl(el);
      if (el) setAnchorRect(el.getBoundingClientRect());
    };

    const timer = setTimeout(findAnchor, 300);
    const handleUpdate = () => findAnchor();
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [tooltip.target]);

  const virtualRef = {
    current: {
      getBoundingClientRect: () => anchorEl?.getBoundingClientRect() ?? new DOMRect(),
    },
  };

  if (!anchorEl || !anchorRect) return null;

  return (
    <>
      {/* Highlight ring on the anchor element (Radix popover is non-modal, so
          there is no backdrop — the ring is portaled on top of the page). */}
      {createPortal(
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 rounded-md ring-2 ring-[color:oklch(85%_0.15_250)] ring-offset-2 ring-offset-transparent"
          style={{
            top: anchorRect.top - 4,
            left: anchorRect.left - 4,
            width: anchorRect.width + 8,
            height: anchorRect.height + 8,
          }}
        />,
        document.body
      )}

      <Popover
        open
        onOpenChange={open => {
          if (!open) onDismiss();
        }}
      >
        <PopoverAnchor virtualRef={virtualRef} />
        <PopoverContent
          side="right"
          align="center"
          sideOffset={12}
          collisionPadding={8}
          className="w-72 p-4 motion-reduce:animate-none"
          onOpenAutoFocus={e => e.preventDefault()}
        >
          {/* Close button */}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss tip"
            className="text-muted-foreground hover:bg-surface-hover hover:text-foreground absolute top-2 right-2 rounded-md p-1 transition-colors"
          >
            <X className="size-3.5" />
          </button>

          {/* Title */}
          <div className="text-foreground mb-1 text-sm font-semibold">{tooltip.title}</div>

          {/* Description */}
          <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
            {tooltip.description}
          </p>

          {/* Actions */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onDismissAll}
              className="text-muted-foreground hover:text-foreground text-[10px] transition-colors"
            >
              Don&apos;t show these again
            </button>

            <button
              type="button"
              onClick={onDismiss}
              className="bg-surface-hover text-foreground hover:bg-surface-selected rounded-md px-3 py-1 text-xs font-medium transition-colors"
            >
              Got it
            </button>
          </div>

          {/* Progress dots */}
          <div className="mt-3 flex justify-center gap-1.5">
            {ONBOARDING_TOOLTIPS.map(t => (
              <div
                key={t.id}
                className={`size-1.5 rounded-full transition-colors ${
                  t.id === tooltip.id ? 'bg-[color:oklch(85%_0.15_250)]' : 'bg-border'
                }`}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
