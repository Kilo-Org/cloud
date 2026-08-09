import { afterEach, describe, expect, it, vi } from 'vitest';
import { logExportEvent, safeError } from './observability';

afterEach(() => vi.restoreAllMocks());

describe('export observability', () => {
  it('logs structured fields with a stable service name', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logExportEvent('info', 'export_test_event', {
      exportId: 'export-id',
      generation: 2,
      source: null,
    });

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      event: 'export_test_event',
      service: 'user-data-export',
      exportId: 'export-id',
      generation: 2,
      source: null,
    });
  });

  it('classifies errors without exposing messages or stacks', () => {
    const error = Object.assign(new Error('postgres://secret@host private query text'), {
      code: 'ECONNRESET',
    });

    expect(safeError(error)).toEqual({ errorName: 'Error', errorCode: 'ECONNRESET' });
    expect(JSON.stringify(safeError(error))).not.toContain('secret');
    expect(JSON.stringify(safeError(error))).not.toContain('query');
  });

  it('does not copy properties from non-error throws', () => {
    expect(safeError({ token: 'secret-token', message: 'private' })).toEqual({
      errorName: 'NonErrorThrow',
    });
  });

  it('drops nonstandard names and codes that could contain sensitive text', () => {
    const error = Object.assign(new Error('private'), {
      name: 'Database secret leaked',
      code: 'secret-token',
    });

    expect(safeError(error)).toEqual({ errorName: 'Error' });
  });
});
