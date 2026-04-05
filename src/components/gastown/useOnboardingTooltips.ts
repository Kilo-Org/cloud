'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types ────────────────────────────────────────────────────────────────

export type OnboardingTooltipId = 'convoy' | 'agents' | 'merges' | 'mayor';

/** Ordered list of tooltip definitions. Shown sequentially. */
export const ONBOARDING_TOOLTIPS: ReadonlyArray<{
  id: OnboardingTooltipId;
  /** data-onboarding-target value on the anchor element */
  target: string;
  title: string;
  description: string;
}> = [
  {
    id: 'convoy',
    target: 'onboarding-beads',
    title: 'Beads',
    description: 'This tracked your task. Create convoys to batch related work.',
  },
  {
    id: 'agents',
    target: 'onboarding-agents',
    title: 'Agents',
    description: 'This polecat worked on your task. Click to see its full conversation.',
  },
  {
    id: 'merges',
    target: 'onboarding-merges',
    title: 'Merge Queue',
    description: 'Your code changes are reviewed here before merging.',
  },
  {
    id: 'mayor',
    target: 'onboarding-mayor',
    title: 'Mayor',
    description:
      'You can also ask me to work on multiple things at once, check on progress, or coordinate across repos.',
  },
];

// ── localStorage helpers ─────────────────────────────────────────────────

function storageKey(townId: string) {
  return `gastown_onboarding_tooltips_shown_${townId}`;
}

const VALID_IDS = new Set<string>(ONBOARDING_TOOLTIPS.map(t => t.id));

function isValidTooltipId(value: unknown): value is OnboardingTooltipId {
  return typeof value === 'string' && VALID_IDS.has(value);
}

function readDismissedSet(townId: string): Set<OnboardingTooltipId> {
  try {
    const raw = localStorage.getItem(storageKey(townId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const validIds = parsed.filter(isValidTooltipId);
      return new Set(validIds);
    }
  } catch {
    // Corrupted or unavailable — treat as empty
  }
  return new Set();
}

function writeDismissedSet(townId: string, dismissed: Set<OnboardingTooltipId>) {
  try {
    localStorage.setItem(storageKey(townId), JSON.stringify([...dismissed]));
  } catch {
    // localStorage unavailable
  }
}

function isAllDismissed(townId: string): boolean {
  const dismissed = readDismissedSet(townId);
  return ONBOARDING_TOOLTIPS.every(t => dismissed.has(t.id));
}

// ── Hook ─────────────────────────────────────────────────────────────────

type UseOnboardingTooltipsResult = {
  /** The tooltip currently being shown, or null if none. */
  activeTooltip: (typeof ONBOARDING_TOOLTIPS)[number] | null;
  /** Dismiss the currently active tooltip and advance to the next. */
  dismissCurrent: () => void;
  /** Dismiss all remaining tooltips at once. */
  dismissAll: () => void;
  /** Whether tooltips should be active at all (first task completed + not all dismissed). */
  active: boolean;
  /** Trigger the tooltip sequence (call when first bead completion is detected). */
  triggerTooltips: () => void;
};

export function useOnboardingTooltips(townId: string): UseOnboardingTooltipsResult {
  const [dismissed, setDismissed] = useState<Set<OnboardingTooltipId>>(() =>
    readDismissedSet(townId)
  );
  const [triggered, setTriggered] = useState(false);

  // Reset state when townId changes
  const prevTownIdRef = useRef(townId);
  useEffect(() => {
    if (prevTownIdRef.current !== townId) {
      prevTownIdRef.current = townId;
      setDismissed(readDismissedSet(townId));
      setTriggered(false);
    }
  }, [townId]);

  const allDone = ONBOARDING_TOOLTIPS.every(t => dismissed.has(t.id));

  // Find next undismissed tooltip
  const activeTooltip =
    triggered && !allDone ? (ONBOARDING_TOOLTIPS.find(t => !dismissed.has(t.id)) ?? null) : null;

  const dismissCurrent = useCallback(() => {
    if (!activeTooltip) return;
    setDismissed(prev => {
      const next = new Set(prev);
      next.add(activeTooltip.id);
      writeDismissedSet(townId, next);
      return next;
    });
  }, [activeTooltip, townId]);

  const dismissAll = useCallback(() => {
    const all = new Set(ONBOARDING_TOOLTIPS.map(t => t.id));
    setDismissed(all);
    writeDismissedSet(townId, all);
  }, [townId]);

  const triggerTooltips = useCallback(() => {
    // Only trigger if not already all dismissed
    if (!isAllDismissed(townId)) {
      setTriggered(true);
    }
  }, [townId]);

  return {
    activeTooltip,
    dismissCurrent,
    dismissAll,
    active: triggered && !allDone,
    triggerTooltips,
  };
}
