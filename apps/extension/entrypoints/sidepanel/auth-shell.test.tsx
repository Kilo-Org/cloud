/* eslint-disable import/first, jest/no-hooks, jest/no-untyped-mock-factory, no-unsafe-type-assertion, vitest/prefer-import-in-mock -- test fixture constraints */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('#imports', () => ({ storage: {} }));

vi.mock('@/src/shared/analytics', () => ({
  getFirefoxUsageDataGranted: vi.fn(),
  loadAnalyticsOptOut: vi.fn(),
  setAnalyticsOptOut: vi.fn(),
}));

import { getFirefoxUsageDataGranted, loadAnalyticsOptOut } from '@/src/shared/analytics';
import { AnalyticsSettingsRow } from './auth-shell';

const mockLoadAnalyticsOptOut = vi.mocked(loadAnalyticsOptOut);
const mockGetFirefoxUsageDataGranted = vi.mocked(getFirefoxUsageDataGranted);

const ERROR_COPY = "Couldn't load the analytics setting.";
const TOGGLE_NAME = 'Share usage analytics';

describe('analytics settings load failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFirefoxUsageDataGranted.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the failure instead of leaving the toggle silently disabled', async () => {
    mockLoadAnalyticsOptOut.mockRejectedValueOnce(new Error('storage unavailable'));

    const { findByText, getByLabelText } = render(
      <AnalyticsSettingsRow userEmail="user@example.com" />
    );

    await findByText(ERROR_COPY);
    expect((getByLabelText(TOGGLE_NAME) as HTMLButtonElement).disabled).toBe(true);
  });

  it('retries the read and enables the toggle once it succeeds', async () => {
    mockLoadAnalyticsOptOut.mockRejectedValueOnce(new Error('storage unavailable'));

    const { findByText, getByLabelText, getByRole, queryByText } = render(
      <AnalyticsSettingsRow userEmail="user@example.com" />
    );

    await findByText(ERROR_COPY);

    mockLoadAnalyticsOptOut.mockResolvedValueOnce(false);
    fireEvent.click(getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(queryByText(ERROR_COPY)).toBeNull();
    });

    const toggle = getByLabelText(TOGGLE_NAME) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(mockLoadAnalyticsOptOut).toHaveBeenCalledTimes(2);
  });
});
