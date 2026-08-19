/* eslint-disable import/first, jest/no-conditional-expect, jest/no-conditional-in-test, jest/no-hooks, jest/no-untyped-mock-factory, no-unsafe-type-assertion, promise/avoid-new, vitest/prefer-import-in-mock, vitest/prefer-called-times -- test fixture constraints */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('#imports', () => ({ storage: {} }));

vi.mock('@/src/shared/web-mcp-settings', () => ({
  loadWebMcpSettings: vi.fn(),
  saveWebMcpSettings: vi.fn(),
}));

import { loadWebMcpSettings, saveWebMcpSettings } from '@/src/shared/web-mcp-settings';
import { WebMcpSettings } from './web-mcp-settings';

const mockLoad = vi.mocked(loadWebMcpSettings);
const mockSave = vi.mocked(saveWebMcpSettings);

const TOGGLE_LABEL = 'Allow WebMCP in safe mode';

describe('web MCP settings toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the stored value and persists a toggle', async () => {
    mockLoad.mockResolvedValue({ allowWebMcpInSafeMode: false });
    mockSave.mockResolvedValue();

    const { getByLabelText } = render(<WebMcpSettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith(expect.anything(), {
        allowWebMcpInSafeMode: true,
      });
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the saved value after a reload', async () => {
    mockLoad.mockResolvedValue({ allowWebMcpInSafeMode: true });

    const { getByLabelText } = render(<WebMcpSettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the toggle disabled when the setting cannot be read', async () => {
    mockLoad.mockRejectedValue(new Error('read failed'));

    const { getByLabelText } = render(<WebMcpSettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      // eslint-disable-next-line vitest/prefer-called-times -- current linter requires CalledOnce; avoiding contradiction
      expect(mockLoad).toHaveBeenCalledOnce();
    });
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('retries the load and clears the error after success', async () => {
    mockLoad
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({ allowWebMcpInSafeMode: true });

    const { getByLabelText, queryByText } = render(<WebMcpSettings />);

    await waitFor(() => {
      expect(getByLabelText('Retry loading WebMCP settings')).toBeDefined();
    });

    const retryButton = getByLabelText('Retry loading WebMCP settings');
    if (retryButton instanceof HTMLButtonElement) {
      retryButton.click();
    }

    await waitFor(() => {
      expect(queryByText("Couldn't load the setting. Try again.")).toBeNull();
    });
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;
    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('rolls back and reports a failed save', async () => {
    mockLoad.mockResolvedValue({ allowWebMcpInSafeMode: false });
    mockSave.mockRejectedValue(new Error('write failed'));

    const { getByLabelText, findByText } = render(<WebMcpSettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    fireEvent.click(toggle);

    await findByText("Couldn't save the setting. Try again.");
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('retries the failed save and clears the error after success', async () => {
    mockLoad.mockResolvedValue({ allowWebMcpInSafeMode: false });
    mockSave.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce();

    const { getByLabelText, queryByText } = render(<WebMcpSettings />);
    const toggle = getByLabelText(TOGGLE_LABEL) as HTMLButtonElement;

    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(getByLabelText('Retry saving WebMCP settings')).toBeDefined();
    });
    expect(mockSave).toHaveBeenCalledOnce();

    const retryButton = getByLabelText('Retry saving WebMCP settings');
    if (retryButton instanceof HTMLButtonElement) {
      retryButton.click();
    }

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledTimes(2);
      expect(mockSave).toHaveBeenLastCalledWith(expect.anything(), {
        allowWebMcpInSafeMode: true,
      });
    });
    await waitFor(() => {
      expect(queryByText("Couldn't save the setting. Try again.")).toBeNull();
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});
