import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withDORetry } from './do-retry.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
};

// Track delay values passed to setTimeout while resolving immediately
const recordedDelays: number[] = [];
let originalSetTimeout: typeof globalThis.setTimeout;

describe('withDORetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedDelays.length = 0;
    originalSetTimeout = globalThis.setTimeout;
    // Replace setTimeout to record delays but resolve immediately
    vi.stubGlobal('setTimeout', (fn: () => void, delay?: number) => {
      recordedDelays.push(delay ?? 0);
      return originalSetTimeout(fn, 0);
    });
  });

  afterEach(() => {
    vi.stubGlobal('setTimeout', originalSetTimeout);
    vi.restoreAllMocks();
  });

  describe('successful operations', () => {
    it('returns result on first attempt success', async () => {
      const mockStub = { getMetadata: vi.fn().mockResolvedValue({ id: '123' }) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      const result = await withDORetry(
        getStub,
        (stub: typeof mockStub) => stub.getMetadata() as Promise<{ id: string }>,
        'getMetadata',
        undefined,
        mockLogger
      );

      expect(result).toEqual({ id: '123' });
      expect(getStub).toHaveBeenCalledTimes(1);
      expect(mockStub.getMetadata).toHaveBeenCalledTimes(1);
      expect(recordedDelays).toHaveLength(0);
    });

    it('returns result after retry on retryable error', async () => {
      const retryableError = Object.assign(new Error('Transient DO error'), { retryable: true });
      const mockStub1 = { getMetadata: vi.fn().mockRejectedValue(retryableError) };
      const mockStub2 = { getMetadata: vi.fn().mockResolvedValue({ id: '456' }) };

      let callCount = 0;
      const getStub = vi.fn(() => {
        callCount++;
        return callCount === 1 ? mockStub1 : mockStub2;
      });

      const result = await withDORetry(
        getStub,
        (stub: typeof mockStub1) => stub.getMetadata() as Promise<{ id: string }>,
        'getMetadata',
        undefined,
        mockLogger
      );

      expect(result).toEqual({ id: '456' });
      expect(getStub).toHaveBeenCalledTimes(2);
      expect(recordedDelays).toHaveLength(1);
    });

    it('creates fresh stub for each retry attempt', async () => {
      const retryableError = Object.assign(new Error('Transient error'), { retryable: true });
      const mockStub1 = { update: vi.fn().mockRejectedValue(retryableError) };
      const mockStub2 = { update: vi.fn().mockRejectedValue(retryableError) };
      const mockStub3 = { update: vi.fn().mockResolvedValue(undefined) };

      const stubs = [mockStub1, mockStub2, mockStub3];
      let stubIndex = 0;
      const getStub = vi.fn(() => stubs[stubIndex++]);

      await withDORetry(
        getStub,
        (stub: typeof mockStub1) => stub.update() as Promise<undefined>,
        'update',
        undefined,
        mockLogger
      );

      expect(getStub).toHaveBeenCalledTimes(3);
      expect(mockStub1.update).toHaveBeenCalledTimes(1);
      expect(mockStub2.update).toHaveBeenCalledTimes(1);
      expect(mockStub3.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryable error detection', () => {
    it('retries on error with .retryable = true', async () => {
      const retryableError = Object.assign(new Error('Some error'), { retryable: true });
      const mockStub1 = { op: vi.fn().mockRejectedValue(retryableError) };
      const mockStub2 = { op: vi.fn().mockResolvedValue('success') };

      let callCount = 0;
      const getStub = vi.fn(() => (++callCount === 1 ? mockStub1 : mockStub2));

      const result = await withDORetry(
        getStub,
        (stub: typeof mockStub1) => stub.op() as Promise<string>,
        'op',
        undefined,
        mockLogger
      );

      expect(result).toBe('success');
      expect(getStub).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on error message patterns without .retryable property', async () => {
      // These error messages were previously retried based on string matching,
      // but now we only check .retryable property per Cloudflare docs
      const errorMessages = [
        'Internal error in Durable Object storage',
        'Durable Object reset because its code was updated',
        'Network connection lost',
        'The Durable Object is overloaded',
      ];

      for (const message of errorMessages) {
        vi.clearAllMocks();
        recordedDelays.length = 0;
        const error = new Error(message);
        const mockStub = { op: vi.fn().mockRejectedValue(error) };
        const getStub = vi.fn().mockReturnValue(mockStub);

        await expect(
          withDORetry(
            getStub,
            (stub: typeof mockStub) => stub.op() as Promise<string>,
            'op',
            undefined,
            mockLogger
          )
        ).rejects.toThrow(message);

        // Should NOT retry - fails immediately
        expect(getStub).toHaveBeenCalledTimes(1);
        expect(recordedDelays).toHaveLength(0);
      }
    });

    it('retries on error message patterns when .retryable = true is set', async () => {
      const error = Object.assign(new Error('Internal error in Durable Object storage'), {
        retryable: true,
      });
      const mockStub1 = { op: vi.fn().mockRejectedValue(error) };
      const mockStub2 = { op: vi.fn().mockResolvedValue('ok') };

      let callCount = 0;
      const getStub = vi.fn(() => (++callCount === 1 ? mockStub1 : mockStub2));

      await withDORetry(
        getStub,
        (stub: typeof mockStub1) => stub.op() as Promise<string>,
        'op',
        undefined,
        mockLogger
      );

      expect(getStub).toHaveBeenCalledTimes(2);
    });
  });

  describe('non-retryable errors', () => {
    it('throws immediately on non-retryable error', async () => {
      const nonRetryableError = new Error('Validation failed: invalid data');
      const mockStub = { op: vi.fn().mockRejectedValue(nonRetryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'op',
          undefined,
          mockLogger
        )
      ).rejects.toThrow('Validation failed: invalid data');

      expect(getStub).toHaveBeenCalledTimes(1);
      expect(recordedDelays).toHaveLength(0);
    });

    it('throws immediately when .retryable = false', async () => {
      const error = Object.assign(new Error('Permanent failure'), { retryable: false });
      const mockStub = { op: vi.fn().mockRejectedValue(error) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'op',
          undefined,
          mockLogger
        )
      ).rejects.toThrow('Permanent failure');

      expect(getStub).toHaveBeenCalledTimes(1);
    });

    it('converts non-Error throws to Error', async () => {
      const mockStub = { op: vi.fn().mockRejectedValue('string error') };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'op',
          undefined,
          mockLogger
        )
      ).rejects.toThrow('string error');
    });
  });

  describe('retry exhaustion', () => {
    it('throws after exhausting all retry attempts', async () => {
      const retryableError = Object.assign(new Error('Persistent transient error'), {
        retryable: true,
      });
      const mockStub = { op: vi.fn().mockRejectedValue(retryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'op',
          undefined,
          mockLogger
        )
      ).rejects.toThrow('Persistent transient error');

      // Default is 3 attempts
      expect(getStub).toHaveBeenCalledTimes(3);
      expect(recordedDelays).toHaveLength(2); // 2 waits between 3 attempts
    });

    it('respects custom maxAttempts config', async () => {
      const retryableError = Object.assign(new Error('Error'), { retryable: true });
      const mockStub = { op: vi.fn().mockRejectedValue(retryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'op',
          { maxAttempts: 5, baseBackoffMs: 100, maxBackoffMs: 5000 },
          mockLogger
        )
      ).rejects.toThrow('Error');

      expect(getStub).toHaveBeenCalledTimes(5);
      expect(recordedDelays).toHaveLength(4);
    });

    it('respects maxAttempts: 1 (no retries at all)', async () => {
      const retryableError = Object.assign(new Error('fail'), { retryable: true });
      const getStub = vi.fn(() => 'stub');
      const operation = vi.fn(async () => {
        throw retryableError;
      });

      await expect(
        withDORetry(getStub, operation, 'test-op', {
          maxAttempts: 1,
          baseBackoffMs: 1,
          maxBackoffMs: 10,
        })
      ).rejects.toThrow('fail');

      expect(operation).toHaveBeenCalledTimes(1);
      expect(recordedDelays).toHaveLength(0);
    });
  });

  describe('backoff behavior', () => {
    it('applies exponential backoff with jitter', async () => {
      const retryableError = Object.assign(new Error('Error'), { retryable: true });
      const mockStub1 = { op: vi.fn().mockRejectedValue(retryableError) };
      const mockStub2 = { op: vi.fn().mockRejectedValue(retryableError) };
      const mockStub3 = { op: vi.fn().mockResolvedValue('ok') };

      const stubs = [mockStub1, mockStub2, mockStub3];
      let stubIndex = 0;
      const getStub = vi.fn(() => stubs[stubIndex++]);

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      await withDORetry(
        getStub,
        (stub: typeof mockStub1) => stub.op() as Promise<string>,
        'op',
        { maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 5000 },
        mockLogger
      );

      // First backoff: 100 * 0.5 * 2^0 = 50ms
      // Second backoff: 100 * 0.5 * 2^1 = 100ms
      expect(recordedDelays).toHaveLength(2);
      expect(recordedDelays[0]).toBe(50);
      expect(recordedDelays[1]).toBe(100);

      randomSpy.mockRestore();
    });

    it('caps backoff at maxBackoffMs', async () => {
      const retryableError = Object.assign(new Error('Error'), { retryable: true });
      const mockStub = { op: vi.fn().mockRejectedValue(retryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'op',
          { maxAttempts: 5, baseBackoffMs: 1000, maxBackoffMs: 2000 },
          mockLogger
        )
      ).rejects.toThrow();

      // With random=1:
      // Attempt 0: 1000 * 1 * 2^0 = 1000ms
      // Attempt 1: 1000 * 1 * 2^1 = 2000ms (at cap)
      // Attempt 2: 1000 * 1 * 2^2 = 4000ms -> capped to 2000ms
      // Attempt 3: 1000 * 1 * 2^3 = 8000ms -> capped to 2000ms
      expect(recordedDelays[0]).toBe(1000);
      expect(recordedDelays[1]).toBe(2000);
      expect(recordedDelays[2]).toBe(2000);
      expect(recordedDelays[3]).toBe(2000);

      randomSpy.mockRestore();
    });
  });

  describe('type safety', () => {
    it('preserves return type from operation', async () => {
      type Metadata = { id: string; name: string };
      const mockStub = {
        getMetadata: vi.fn().mockResolvedValue({ id: '1', name: 'test' } satisfies Metadata),
      };
      const getStub = vi.fn().mockReturnValue(mockStub);

      const result: Metadata = await withDORetry(
        getStub,
        (stub: typeof mockStub) => stub.getMetadata() as Promise<Metadata>,
        'getMetadata',
        undefined,
        mockLogger
      );

      expect(result.id).toBe('1');
      expect(result.name).toBe('test');
    });

    it('handles void return type', async () => {
      const mockStub = { deleteSession: vi.fn().mockResolvedValue(undefined) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      const result = await withDORetry(
        getStub,
        (stub: typeof mockStub) => stub.deleteSession() as Promise<undefined>,
        'deleteSession',
        undefined,
        mockLogger
      );

      expect(result).toBeUndefined();
    });
  });

  describe('logging', () => {
    it('logs non-retryable errors as warnings', async () => {
      const error = new Error('app error');
      const mockStub = { op: vi.fn().mockRejectedValue(error) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'myOp',
          undefined,
          mockLogger
        )
      ).rejects.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledWith('[do-retry] Non-retryable error', {
        operation: 'myOp',
        attempt: 1,
        error: 'app error',
        retryable: false,
      });
    });

    it('logs exhaustion as errors', async () => {
      const retryableError = Object.assign(new Error('transient'), { retryable: true });
      const mockStub = { op: vi.fn().mockRejectedValue(retryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(
          getStub,
          (stub: typeof mockStub) => stub.op() as Promise<string>,
          'myOp',
          { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 10 },
          mockLogger
        )
      ).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith('[do-retry] All retry attempts exhausted', {
        operation: 'myOp',
        attempts: 2,
        error: 'transient',
      });
    });
  });
});
