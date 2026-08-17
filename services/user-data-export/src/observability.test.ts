import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyFetchFailure,
  logExportEvent,
  safeError,
  setSpanFields,
  withSpan,
  type ExportSpan,
} from './observability';

function recordingSpan(): ExportSpan & { attributes: [string, unknown][] } {
  const attributes: [string, unknown][] = [];
  return {
    attributes,
    isTraced: true,
    setAttribute: (key, value) => void attributes.push([key, value]),
  };
}

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

describe('span fields', () => {
  it('copies booleans, numbers, and strings onto the span', () => {
    const span = recordingSpan();

    setSpanFields(span, { source: 'cli_sessions', 'export.page': 3, 'export.done': false });

    expect(span.attributes).toEqual([
      ['source', 'cli_sessions'],
      ['export.page', 3],
      ['export.done', false],
    ]);
  });

  /**
   * setAttribute rejects null, and our field records use null freely for values that are
   * not resolved yet, so dropping both null and undefined keeps call sites from having to
   * pre-filter.
   */
  it('drops null and undefined instead of forwarding them', () => {
    const span = recordingSpan();

    setSpanFields(span, { source: null, generation: undefined, exportId: 'export-id' });

    expect(span.attributes).toEqual([['exportId', 'export-id']]);
  });
});

describe('withSpan', () => {
  it('returns the callback result so instrumentation stays transparent', async () => {
    await expect(withSpan('probe', { source: 'test' }, async () => 'value')).resolves.toBe('value');
    expect(withSpan('probe', {}, () => 42)).toBe(42);
  });

  it('propagates failures rather than swallowing them', async () => {
    const failure = new Error('read failed');

    await expect(
      withSpan('probe', {}, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});

describe('classifyFetchFailure', () => {
  it('distinguishes an AbortSignal timeout from a manual abort', () => {
    expect(classifyFetchFailure(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
    expect(classifyFetchFailure(new DOMException('aborted', 'AbortError'))).toBe('aborted');
  });

  it('recognizes a disallowed redirect thrown under redirect: error', () => {
    expect(
      classifyFetchFailure(new TypeError("Fetch API cannot follow a redirect in mode 'error'"))
    ).toBe('redirect');
  });

  it('recognizes dropped connections and network failures', () => {
    expect(classifyFetchFailure(new TypeError('Network connection lost.'))).toBe('connection');
    expect(classifyFetchFailure(new TypeError('The connection was reset.'))).toBe('connection');
    expect(classifyFetchFailure(new TypeError('fetch failed'))).toBe('connection');
  });

  it('falls back to unknown for unrecognized or non-error throws', () => {
    expect(classifyFetchFailure(new TypeError('something unexpected'))).toBe('unknown');
    expect(classifyFetchFailure({ message: 'redirect' })).toBe('unknown');
    expect(classifyFetchFailure('redirect')).toBe('unknown');
  });

  it('never returns the original message text, only a fixed literal', () => {
    const reason = classifyFetchFailure(
      new TypeError('redirect to https://evil.example/?token=postgres://secret@host')
    );
    expect(reason).toBe('redirect');
    expect(reason).not.toContain('secret');
    expect(reason).not.toContain('token');
    expect(reason).not.toContain('https');
  });
});
