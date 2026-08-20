/* eslint-disable import/first, jest/no-conditional-expect, jest/no-hooks, jest/no-untyped-mock-factory, no-unsafe-type-assertion, promise/avoid-new, vitest/prefer-import-in-mock -- test fixture constraints */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('#imports', () => ({ storage: {} }));

vi.mock('./use-agent-memories', () => ({
  useAgentMemories: () => ({
    isLoaded: true,
    loadError: false,
    memories: [],
    pendingDraft: undefined,
    reload: vi.fn(),
  }),
}));

vi.mock('@/src/shared/agent-memory-settings', () => ({
  loadMemorySettings: vi.fn(),
  saveMemorySettings: vi.fn(),
}));

import { loadMemorySettings, saveMemorySettings } from '@/src/shared/agent-memory-settings';
import { MemorySettings } from './memory-settings';

const mockLoad = vi.mocked(loadMemorySettings);
const mockSave = vi.mocked(saveMemorySettings);

const TOGGLE_LABEL = 'Auto-approve memory saves';

describe('memory settings auto-approve toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the stored value and persists a toggle', async () => {
    mockLoad.mockResolvedValue({ autoApproveMemorySaves: false });
    mockSave.mockResolvedValue();

    const { getByLabelText } = render(<MemorySettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith(expect.anything(), {
        autoApproveMemorySaves: true,
      });
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the toggle disabled when the setting cannot be read', async () => {
    mockLoad.mockRejectedValue(new Error('read failed'));

    const { getByLabelText } = render(<MemorySettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      // eslint-disable-next-line vitest/prefer-called-times -- current linter requires CalledOnce; avoiding contradiction
      expect(mockLoad).toHaveBeenCalledOnce();
    });
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('stores the last toggle when saves overlap', async () => {
    mockLoad.mockResolvedValue({ autoApproveMemorySaves: false });
    /* The first write resolves only after the second one is requested, so an
       unordered implementation would store `true` while the toggle reads off. */
    const settleFirstSave: (() => void)[] = [];
    const firstSave = new Promise<void>(resolve => {
      settleFirstSave.push(resolve);
    });
    mockSave.mockReturnValueOnce(firstSave);
    mockSave.mockResolvedValueOnce();

    const { getByLabelText } = render(<MemorySettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // Only the first save has started; the second waits its turn.
    await waitFor(() => {
      expect(settleFirstSave).toHaveLength(1);
    });
    // eslint-disable-next-line vitest/prefer-called-times -- current linter requires CalledOnce; avoiding contradiction
    expect(mockSave).toHaveBeenCalledOnce();

    settleFirstSave[0]?.();

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledTimes(2);
    });
    expect(mockSave).toHaveBeenLastCalledWith(expect.anything(), {
      autoApproveMemorySaves: false,
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('rolls back and reports a failed save', async () => {
    mockLoad.mockResolvedValue({ autoApproveMemorySaves: false });
    mockSave.mockRejectedValue(new Error('write failed'));

    const { getByLabelText, findByText } = render(<MemorySettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    fireEvent.click(toggle);

    await findByText("Couldn't save the setting. Try again.");
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
