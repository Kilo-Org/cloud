import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { KiloClient } from './client.js';
import {
  KiloApiError,
  KiloClientError,
  KiloServerNotReadyError,
  KiloSessionNotFoundError,
  KiloSessionNotSetError,
  KiloTimeoutError,
} from './errors.js';
import type { ExecutionSession } from '../types.js';
import type { Session, SessionCommandResponse } from './types.js';

type KiloClientPrivates = {
  parseResponse: (stdout: string) => { responseBody: string; httpStatus: number };
  parseExecError: (
    result: { exitCode: number; stdout: string; stderr: string },
    method: string,
    path: string,
    timeoutSeconds: number,
    httpStatus: number,
    responseBody: string
  ) => KiloClientError;
  requireSession: () => string;
};

const getPrivates = (client: KiloClient): KiloClientPrivates =>
  client as unknown as KiloClientPrivates;

const createExecSession = (): ExecutionSession =>
  ({
    exec: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
  }) as unknown as ExecutionSession;

const buildSession = (id: string): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/tmp',
  title: 'Test Session',
  version: '1',
  time: {
    created: 1,
    updated: 2,
  },
});

describe('KiloClient', () => {
  describe('parseResponse', () => {
    it('extracts status code and body', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const result = getPrivates(client).parseResponse('ok\n200');
      expect(result).toEqual({ responseBody: 'ok', httpStatus: 200 });
    });

    it('handles empty response with status', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const result = getPrivates(client).parseResponse('\n204');
      expect(result).toEqual({ responseBody: '', httpStatus: 204 });
    });

    it('handles missing newline', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const result = getPrivates(client).parseResponse('just-body');
      expect(result).toEqual({ responseBody: 'just-body', httpStatus: 0 });
    });

    it('handles malformed status code', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const result = getPrivates(client).parseResponse('ok\nabc');
      expect(result).toEqual({ responseBody: 'ok', httpStatus: 0 });
    });
  });

  describe('parseExecError', () => {
    it('classifies HTTP errors with JSON body', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const error = getPrivates(client).parseExecError(
        { exitCode: 22, stdout: '', stderr: '' },
        'GET',
        '/path',
        10,
        400,
        JSON.stringify({ message: 'bad request' })
      );
      expect(error).toBeInstanceOf(KiloApiError);
      expect(error.message).toContain('bad request');
    });

    it('classifies HTTP errors with plain text body', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const error = getPrivates(client).parseExecError(
        { exitCode: 22, stdout: '', stderr: '' },
        'GET',
        '/path',
        10,
        500,
        'oops'
      );
      expect(error).toBeInstanceOf(KiloApiError);
      expect(error.message).toContain('oops');
    });

    it('classifies timeout errors', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const error = getPrivates(client).parseExecError(
        { exitCode: 28, stdout: '', stderr: '' },
        'GET',
        '/path',
        3,
        0,
        ''
      );
      expect(error).toBeInstanceOf(KiloTimeoutError);
      expect((error as KiloTimeoutError).timeoutMs).toBe(3000);
    });

    it('classifies connection refused errors', () => {
      const client = new KiloClient({ session: createExecSession(), port: 4321 });
      const error = getPrivates(client).parseExecError(
        { exitCode: 7, stdout: '', stderr: '' },
        'GET',
        '/path',
        10,
        0,
        ''
      );
      expect(error).toBeInstanceOf(KiloServerNotReadyError);
      expect(error.message).toContain('4321');
    });

    it('classifies unknown errors', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const error = getPrivates(client).parseExecError(
        { exitCode: 9, stdout: '', stderr: 'bad' },
        'GET',
        '/path',
        10,
        0,
        ''
      );
      expect(error).toBeInstanceOf(KiloClientError);
      expect(error.message).toContain('exit 9');
    });
  });

  describe('waitForReady', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('respects overall timeout', async () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const callSpy = vi.spyOn(client, 'call').mockRejectedValue(new Error('nope'));

      const promise = client.waitForReady(1200);
      const expectation = expect(promise).rejects.toBeInstanceOf(KiloServerNotReadyError);
      await vi.advanceTimersByTimeAsync(2000);

      await expectation;
      expect(callSpy).toHaveBeenCalled();
    });
  });

  describe('session state management', () => {
    it('requireSession throws when no session set', () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      expect(() => getPrivates(client).requireSession()).toThrow(KiloSessionNotSetError);
    });

    it('createSession stores session ID', async () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      vi.spyOn(client, 'call').mockResolvedValue(buildSession('ses_1'));
      await client.createSession({ title: 'Title' });
      expect(client.currentSessionId).toBe('ses_1');
    });

    it('resumeSession stores session ID', async () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      vi.spyOn(client, 'call').mockResolvedValue(buildSession('ses_2'));
      await client.resumeSession('ses_2');
      expect(client.currentSessionId).toBe('ses_2');
    });

    it('resumeSession converts 404 to KiloSessionNotFoundError', async () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      vi.spyOn(client, 'call').mockRejectedValue(new KiloApiError('not found', 404));
      await expect(client.resumeSession('missing')).rejects.toBeInstanceOf(
        KiloSessionNotFoundError
      );
    });
  });

  describe('model defaults and passthrough', () => {
    it('defaults summarize providerID to kilo', async () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const callSpy = vi
        .spyOn(client, 'call')
        .mockResolvedValueOnce(buildSession('ses_1'))
        .mockResolvedValueOnce(true);

      await client.resumeSession('ses_1');
      await client.summarize({ modelID: 'anthropic/claude-sonnet-4-20250514' });

      expect(callSpy.mock.calls[1]?.[2]).toEqual({
        providerID: 'kilo',
        modelID: 'anthropic/claude-sonnet-4-20250514',
      });
    });

    it('passes command model string as-is', async () => {
      const client = new KiloClient({ session: createExecSession(), port: 1234 });
      const callSpy = vi
        .spyOn(client, 'call')
        .mockResolvedValueOnce(buildSession('ses_1'))
        .mockResolvedValueOnce({} as unknown as SessionCommandResponse);

      await client.resumeSession('ses_1');
      await client.command('help', '', { model: 'anthropic/claude-sonnet-4-20250514' });

      expect(callSpy.mock.calls[1]?.[2]).toEqual({
        command: 'help',
        arguments: '',
        messageID: undefined,
        agent: undefined,
        model: 'anthropic/claude-sonnet-4-20250514',
      });
    });
  });
});
