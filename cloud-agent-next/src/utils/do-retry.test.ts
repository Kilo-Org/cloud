import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withDORetry } from './do-retry.js';

// Mock the logger
vi.mock('../logger.js', () => ({
  logger: {
    withFields: vi.fn(() => ({
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// Mock scheduler.wait (Cloudflare Workers global)
const mockSchedulerWait = vi.fn().mockResolvedValue(undefined);
vi.stubGlobal('scheduler', { wait: mockSchedulerWait });

// Type for mock stubs with various operations
type _MockStub<T> = {
  [K in keyof T]: T[K];
};

describe('withDORetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful operations', () => {
    it('returns result on first attempt success', async () => {
      const mockStub = { getMetadata: vi.fn().mockResolvedValue({ id: '123' }) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      const result = await withDORetry(
        getStub,
        (stub: typeof mockStub) => stub.getMetadata() as Promise<{ id: string }>,
        'getMetadata'
      );

      expect(result).toEqual({ id: '123' });
      expect(getStub).toHaveBeenCalledTimes(1);
      expect(mockStub.getMetadata).toHaveBeenCalledTimes(1);
      expect(mockSchedulerWait).not.toHaveBeenCalled();
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
        'getMetadata'
      );

      expect(result).toEqual({ id: '456' });
      expect(getStub).toHaveBeenCalledTimes(2);
      expect(mockSchedulerWait).toHaveBeenCalledTimes(1);
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
        'update'
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
        'op'
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
        const error = new Error(message);
        const mockStub = { op: vi.fn().mockRejectedValue(error) };
        const getStub = vi.fn().mockReturnValue(mockStub);

        await expect(
          withDORetry(getStub, (stub: typeof mockStub) => stub.op() as Promise<string>, 'op')
        ).rejects.toThrow(message);

        // Should NOT retry - fails immediately
        expect(getStub).toHaveBeenCalledTimes(1);
        expect(mockSchedulerWait).not.toHaveBeenCalled();
      }
    });

    it('retries on error message patterns when .retryable = true is set', async () => {
      // When Cloudflare sets .retryable = true, we should retry regardless of message
      const error = Object.assign(new Error('Internal error in Durable Object storage'), {
        retryable: true,
      });
      const mockStub1 = { op: vi.fn().mockRejectedValue(error) };
      const mockStub2 = { op: vi.fn().mockResolvedValue('ok') };

      let callCount = 0;
      const getStub = vi.fn(() => (++callCount === 1 ? mockStub1 : mockStub2));

      await withDORetry(getStub, (stub: typeof mockStub1) => stub.op() as Promise<string>, 'op');

      expect(getStub).toHaveBeenCalledTimes(2);
    });
  });

  describe('non-retryable errors', () => {
    it('throws immediately on non-retryable error', async () => {
      const nonRetryableError = new Error('Validation failed: invalid data');
      const mockStub = { op: vi.fn().mockRejectedValue(nonRetryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(getStub, (stub: typeof mockStub) => stub.op() as Promise<string>, 'op')
      ).rejects.toThrow('Validation failed: invalid data');

      expect(getStub).toHaveBeenCalledTimes(1);
      expect(mockSchedulerWait).not.toHaveBeenCalled();
    });

    it('throws immediately when .retryable = false', async () => {
      const error = Object.assign(new Error('Permanent failure'), { retryable: false });
      const mockStub = { op: vi.fn().mockRejectedValue(error) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(getStub, (stub: typeof mockStub) => stub.op() as Promise<string>, 'op')
      ).rejects.toThrow('Permanent failure');

      expect(getStub).toHaveBeenCalledTimes(1);
    });

    it('converts non-Error throws to Error', async () => {
      const mockStub = { op: vi.fn().mockRejectedValue('string error') };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(getStub, (stub: typeof mockStub) => stub.op() as Promise<string>, 'op')
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
        withDORetry(getStub, (stub: typeof mockStub) => stub.op() as Promise<string>, 'op')
      ).rejects.toThrow('Persistent transient error');

      // Default is 3 attempts
      expect(getStub).toHaveBeenCalledTimes(3);
      expect(mockSchedulerWait).toHaveBeenCalledTimes(2); // 2 waits between 3 attempts
    });

    it('respects custom maxAttempts config', async () => {
      const retryableError = Object.assign(new Error('Error'), { retryable: true });
      const mockStub = { op: vi.fn().mockRejectedValue(retryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      await expect(
        withDORetry(getStub, (stub: typeof mockStub) => stub.op() as Promise<string>, 'op', {
          maxAttempts: 5,
          baseBackoffMs: 100,
          maxBackoffMs: 5000,
        })
      ).rejects.toThrow('Error');

      expect(getStub).toHaveBeenCalledTimes(5);
      expect(mockSchedulerWait).toHaveBeenCalledTimes(4);
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

      // Mock Math.random to return predictable values
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      await withDORetry(getStub, (stub: typeof mockStub1) => stub.op() as Promise<string>, 'op', {
        maxAttempts: 3,
        baseBackoffMs: 100,
        maxBackoffMs: 5000,
      });

      // First backoff: 100 * 0.5 * 2^0 = 50ms
      // Second backoff: 100 * 0.5 * 2^1 = 100ms
      expect(mockSchedulerWait).toHaveBeenCalledTimes(2);
      expect(mockSchedulerWait).toHaveBeenNthCalledWith(1, 50);
      expect(mockSchedulerWait).toHaveBeenNthCalledWith(2, 100);

      randomSpy.mockRestore();
    });

    it('caps backoff at maxBackoffMs', async () => {
      const retryableError = Object.assign(new Error('Error'), { retryable: true });
      const mockStub = { op: vi.fn().mockRejectedValue(retryableError) };
      const getStub = vi.fn().mockReturnValue(mockStub);

      // Mock Math.random to return 1 (max jitter)
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);

      await expect(
        withDORetry(getStub, (stub: typeof mockStub) => stub.op() as Promise<string>, 'op', {
          maxAttempts: 5,
          baseBackoffMs: 1000,
          maxBackoffMs: 2000,
        })
      ).rejects.toThrow();

      // With random=1:
      // Attempt 0: 1000 * 1 * 2^0 = 1000ms
      // Attempt 1: 1000 * 1 * 2^1 = 2000ms (at cap)
      // Attempt 2: 1000 * 1 * 2^2 = 4000ms -> capped to 2000ms
      // Attempt 3: 1000 * 1 * 2^3 = 8000ms -> capped to 2000ms
      expect(mockSchedulerWait).toHaveBeenNthCalledWith(1, 1000);
      expect(mockSchedulerWait).toHaveBeenNthCalledWith(2, 2000);
      expect(mockSchedulerWait).toHaveBeenNthCalledWith(3, 2000);
      expect(mockSchedulerWait).toHaveBeenNthCalledWith(4, 2000);

      randomSpy.mockRestore();
    });
  });

  describe('type safety', () => {
    it('preserves return type from operation', async () => {
      type Metadata = { id: string; name: string };
      const mockStub = {
        getMetadata: vi.fn().mockResolvedValue({ id: '1', name: 'test' } as Metadata),
      };
      const getStub = vi.fn().mockReturnValue(mockStub);

      const result: Metadata = await withDORetry(
        getStub,
        (stub: typeof mockStub) => stub.getMetadata() as Promise<Metadata>,
        'getMetadata'
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
        'deleteSession'
      );

      expect(result).toBeUndefined();
    });
  });
});
