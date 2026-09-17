import { describe, expect, it, vi } from 'vitest';

import {
  isSessionGoalCollapsed,
  setSessionGoalCollapsed,
} from '@/components/agents/session-goal-collapse';
import { clearSessionScopedState } from '@/lib/auth/session-scoped-state';

// The sign-out aggregation imports the five members that reach native modules;
// their own clears are covered by their own suites. The two in-memory stores
// that hold per-session flags stay real, so the wiring is what is under test.
vi.mock('@/components/agents/file-part-cache', () => ({ clearFilePartCache: vi.fn() }));
vi.mock('@/components/agents/tool-card-image-cache', () => ({ clearToolCardImageCache: vi.fn() }));
vi.mock('@/lib/agent-attachments/clipboard-image', () => ({ clearClipboardImages: vi.fn() }));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({ clearTrustedHosts: vi.fn() }));
vi.mock('@/lib/temp-file-registry', () => ({ reapTempFiles: vi.fn() }));

describe('clearSessionScopedState', () => {
  it('drops the per-session goal disclosure flag on sign-out', () => {
    setSessionGoalCollapsed('session-scoped-goal', true);
    expect(isSessionGoalCollapsed('session-scoped-goal')).toBe(true);

    clearSessionScopedState();

    expect(isSessionGoalCollapsed('session-scoped-goal')).toBe(false);
  });
});
