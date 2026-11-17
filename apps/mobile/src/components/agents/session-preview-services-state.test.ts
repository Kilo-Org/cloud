import { describe, expect, it } from 'vitest';

import { type PreviewService, selectPreviewState } from './session-preview-services-state';

const SERVICE: PreviewService = { port: 3000, name: 'web' };

describe('selectPreviewState', () => {
  it('paints the loading state while the scan is pending', () => {
    expect(selectPreviewState({ data: undefined, isError: false, isPending: true })).toEqual({
      kind: 'loading',
    });
  });

  it('paints a failed scan', () => {
    expect(selectPreviewState({ data: undefined, isError: true, isPending: false })).toEqual({
      kind: 'failed',
    });
  });

  it('paints a settled scan that carries no data as failed', () => {
    expect(selectPreviewState({ data: undefined, isError: false, isPending: false })).toEqual({
      kind: 'failed',
    });
  });

  it('paints the services a running sandbox exposes', () => {
    expect(
      selectPreviewState({
        data: { status: 'running', services: [SERVICE] },
        isError: false,
        isPending: false,
      })
    ).toEqual({ kind: 'services', services: [SERVICE] });
  });

  it('paints a running sandbox with nothing listening as empty', () => {
    expect(
      selectPreviewState({
        data: { status: 'running', services: [] },
        isError: false,
        isPending: false,
      })
    ).toEqual({ kind: 'empty' });
  });

  it.each(['not_running', 'not_ready', 'unsupported'] as const)(
    'paints a %s sandbox as unavailable',
    status => {
      expect(
        selectPreviewState({
          data: { status, services: [] },
          isError: false,
          isPending: false,
        })
      ).toEqual({ kind: 'unavailable', status });
    }
  );
});
