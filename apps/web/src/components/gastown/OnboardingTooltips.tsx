'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
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

function OnboardingTooltipPopover({
  tooltip,
  onDismiss,
  onDismissAll,
}: {
  tooltip: (typeof ONBOARDING_TOOLTIPS)[number];
  onDismiss: () => void;
  onDismissAll: () => void;
}) {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Find the anchor element via data attribute and observe its position
  useEffect(() => {
    const findAnchor = () => {
      const el = document.querySelector(`[data-onboarding-target="${tooltip.target}"]`);
      if (el) {
        setAnchorRect(el.getBoundingClientRect());
      }
    };

    // Initial find with a brief delay for DOM rendering
    const timer = setTimeout(findAnchor, 300);

    // Re-find on scroll/resize
    const handleUpdate = () => findAnchor();
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [tooltip.target]);

  // Calculate position relative to anchor
  useEffect(() => {
    if (!anchorRect || !popoverRef.current) return;

    const popoverRect = popoverRef.current.getBoundingClientRect();
    const gap = 12;

    // Position to the right of the anchor by default
    let top = anchorRect.top + anchorRect.height / 2 - popoverRect.height / 2;
    let left = anchorRect.right + gap;

    // If too far right, position to the left
    if (left + popoverRect.width > window.innerWidth - 16) {
      left = anchorRect.left - popoverRect.width - gap;
    }

    // If still off-screen (e.g., for terminal at bottom), position above
    if (left < 16) {
      left = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2;
      top = anchorRect.top - popoverRect.height - gap;
    }

    // Clamp to viewport
    top = Math.max(8, Math.min(top, window.innerHeight - popoverRect.height - 8));
    left = Math.max(8, Math.min(left, window.innerWidth - popoverRect.width - 8));

    setPosition({ top, left });
  }, [anchorRect]);

  // Dismiss on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss]);

  // Click outside to dismiss
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (
        popoverRef.current &&
        e.target instanceof Node &&
        !popoverRef.current.contains(e.target)
      ) {
        onDismiss();
      }
    },
    [onDismiss]
  );

  if (!anchorRect) return null;

  return (
    <AnimatePresence>
      {/* Semi-transparent backdrop to catch outside clicks */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[100]"
        onClick={handleBackdropClick}
      >
        {/* Highlight ring on the anchor element */}
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-[color:oklch(85%_0.15_250)] ring-offset-2 ring-offset-transparent"
          style={{
            top: anchorRect.top - 4,
            left: anchorRect.left - 4,
            width: anchorRect.width + 8,
            height: anchorRect.height + 8,
          }}
        />

        {/* Popover content */}
        <motion.div
          ref={popoverRef}
          initial={{ opacity: 0, scale: 0.95, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 4 }}
          transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
          className="pointer-events-auto absolute z-[101] w-72 rounded-lg border border-white/[0.15] bg-[#1a1a2e] p-4 shadow-2xl"
          style={position ?? { top: anchorRect.top, left: anchorRect.right + 12, opacity: 0 }}
        >
          {/* Close button */}
          <button
            onClick={e => {
              e.stopPropagation();
              onDismiss();
            }}
            className="absolute top-2 right-2 rounded-md p-1 text-white/30 transition-colors hover:bg-white/[0.08] hover:text-white/60"
          >
            <X className="size-3.5" />
          </button>

          {/* Title */}
          <div className="mb-1 text-sm font-semibold text-white/90">{tooltip.title}</div>

          {/* Description */}
          <p className="mb-3 text-xs leading-relaxed text-white/55">{tooltip.description}</p>

          {/* Actions */}
          <div className="flex items-center justify-between">
            <button
              onClick={e => {
                e.stopPropagation();
                onDismissAll();
              }}
              className="text-[10px] text-white/25 transition-colors hover:text-white/50"
            >
              Don&apos;t show these again
            </button>

            <button
              onClick={e => {
                e.stopPropagation();
                onDismiss();
              }}
              className="rounded-md bg-white/[0.08] px-3 py-1 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.14] hover:text-white/90"
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
                  t.id === tooltip.id ? 'bg-[color:oklch(85%_0.15_250)]' : 'bg-white/15'
                }`}
              />
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
