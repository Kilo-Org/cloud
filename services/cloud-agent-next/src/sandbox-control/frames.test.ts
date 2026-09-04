import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  MAX_WORKTREE_FILE_BYTES,
  MAX_WORKTREE_SNAPSHOT_BYTES,
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  sandboxControlSocketAttachmentSchema,
  sandboxHelloResultSchema,
  sessionGitSnapshotResultSchema,
  type SessionGitSnapshotResult,
  sessionTerminalCloseResultSchema,
  sessionTerminalConnectResultSchema,
  sessionTerminalCreateResultSchema,
  sessionTerminalResizeResultSchema,
  terminalPtyIdSchema,
} from '../shared/sandbox-control-protocol.js';
import {
  errorResponse,
  helloResult,
  isControlEvent,
  isControlOperation,
  isSessionOperation,
  okResponse,
  parseControlFrame,
  parseEventPayload,
  parseOperationPayload,
  parseSandboxHelloPayload,
} from './frames.js';

const operationId = '123e4567-e89b-42d3-a456-426614174000';
const bridgeGeneration = '123e4567-e89b-42d3-a456-426614174001';
const wrapperInstanceId = '123e4567-e89b-42d3-a456-426614174002';
const connectionId = '123e4567-e89b-42d3-a456-426614174003';
const terminalCapability = '0123456789abcdef'.repeat(4);
const terminalPty = {
  id: 'pty_1-valid',
  title: 'Terminal',
  command: '/bin/bash',
  args: ['-l'],
  cwd: '/workspace/repository',
  status: 'running',
  pid: 1234,
};

describe('sandbox control frames', () => {
  it('advertises heartbeat version support without requiring it from an old Worker', () => {
    expect(sandboxHelloResultSchema.parse(helloResult())).toEqual({
      protocolVersion: 1,
      handshakeComplete: true,
      capabilities: { kiloVersionHeartbeat: true },
    });
    const previous = { protocolVersion: 1, handshakeComplete: true };
    expect(sandboxHelloResultSchema.parse(previous)).toEqual(previous);
    for (const capabilities of [
      null,
      { kiloVersionHeartbeat: 'true' },
      { kiloVersionHeartbeat: 1 },
    ]) {
      expect(sandboxHelloResultSchema.safeParse({ ...previous, capabilities }).success).toBe(false);
    }
    expect(
      sandboxHelloResultSchema.safeParse({ ...helloResult(), protocolVersion: 2 }).success
    ).toBe(false);
    expect(
      sandboxHelloResultSchema.safeParse({ ...helloResult(), handshakeComplete: false }).success
    ).toBe(false);
  });

  it('accepts a valid request envelope', () => {
    const parsed = parseControlFrame(
      JSON.stringify({
        type: 'request',
        requestId: 'req_1',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_1' },
      })
    );
    expect(parsed.ok).toBe(true);
  });

  it('rejects invalid JSON and unknown envelopes', () => {
    expect(parseControlFrame('{').ok).toBe(false);
    expect(parseControlFrame(JSON.stringify({ type: 'nope' })).ok).toBe(false);
  });

  it('rejects oversized frames without truncating', () => {
    const parsed = parseControlFrame('x'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES + 1));
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'payload_too_large', message: 'Frame exceeds 12 MiB limit' },
    });
  });

  it.each([
    {
      name: 'request',
      frame: (text: string) => ({
        type: 'request',
        requestId: 'quote"\\漢',
        operation: 'session.prompt',
        session: { sessionId: 'workspace_1', kiloSessionId: 'kilo_1', directory: '/workspace/漢' },
        payload: { messageId: 'message_1', turn: { type: 'prompt', prompt: text } },
      }),
    },
    {
      name: 'success response',
      frame: (text: string) => okResponse('quote"\\漢', { nested: { text } }),
    },
    {
      name: 'error response',
      frame: (text: string) => errorResponse('quote"\\漢', 'protocol_error', text),
    },
    {
      name: 'event',
      frame: (text: string) => ({
        type: 'event',
        event: 'session.event',
        session: { directory: '/workspace/漢' },
        payload: { type: 'message', properties: { text } },
      }),
    },
  ])('checks the final UTF-8 $name envelope at the inclusive 12 MiB ceiling', ({ frame }) => {
    const prefix = '漢"\\\t'.repeat(1000);
    const availableBytes =
      MAX_SANDBOX_CONTROL_FRAME_BYTES - Buffer.byteLength(JSON.stringify(frame(prefix)));
    const text = prefix + 'x'.repeat(availableBytes);
    const encoded = JSON.stringify(frame(text));
    expect(Buffer.byteLength(encoded)).toBe(MAX_SANDBOX_CONTROL_FRAME_BYTES);
    expect(encoded.length).toBeLessThan(MAX_SANDBOX_CONTROL_FRAME_BYTES);
    const parsed = parseControlFrame(encoded);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bytes).toBe(MAX_SANDBOX_CONTROL_FRAME_BYTES);
    expect(parseControlFrame(JSON.stringify(frame(`${text}x`)))).toEqual({
      ok: false,
      error: { code: 'payload_too_large', message: 'Frame exceeds 12 MiB limit' },
    });
  });

  it('keeps a maximum capture nested as an object with room for its final response envelope', () => {
    const files = Array.from(
      { length: 21 },
      (_, index) =>
        ({
          schemaVersion: 1,
          revision: 1,
          path: `quote"\\漢-${index}.ts`,
          diff: { status: 'available', patch: '"\\漢' },
          content: { status: 'unavailable', reason: 'budget_exhausted' },
        }) satisfies SessionGitSnapshotResult['files'][number]
    );
    const snapshot = {
      summary: {
        revision: 1,
        comparison: {
          baseRef: 'refs/remotes/origin/main',
          mergeBase: 'a'.repeat(40),
          head: 'b'.repeat(40),
        },
        files: files.map(file => ({
          path: file.path,
          status: 'modified',
          additions: 1,
          deletions: 1,
          tracked: true,
          binary: false,
          countsComplete: true,
        })),
        truncated: false,
      },
      files,
    } satisfies SessionGitSnapshotResult;
    let padding = MAX_WORKTREE_SNAPSHOT_BYTES - Buffer.byteLength(JSON.stringify(snapshot));
    for (const file of files) {
      const size = Math.min(
        padding,
        MAX_WORKTREE_FILE_BYTES - Buffer.byteLength(JSON.stringify(file))
      );
      file.diff.patch += 'x'.repeat(size);
      padding -= size;
    }
    expect(padding).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBe(MAX_WORKTREE_SNAPSHOT_BYTES);
    const requestId = '"\\漢'.repeat(42);
    const encoded = JSON.stringify(okResponse(requestId, snapshot));
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(MAX_WORKTREE_SNAPSHOT_BYTES);
    expect(Buffer.byteLength(encoded)).toBeLessThan(MAX_SANDBOX_CONTROL_FRAME_BYTES);
    const parsed = parseControlFrame(encoded);
    if (!parsed.ok || parsed.frame.type !== 'response')
      throw new Error('Expected a response frame');
    expect(typeof parsed.frame.result).toBe('object');
    expect(sessionGitSnapshotResultSchema.safeParse(parsed.frame.result).success).toBe(true);
    expect(sessionGitSnapshotResultSchema.safeParse(JSON.stringify(snapshot)).success).toBe(false);

    const oversized = {
      ...snapshot,
      files: files.map((file, index) =>
        index === files.length - 1
          ? { ...file, diff: { ...file.diff, patch: `${file.diff.patch}x` } }
          : file
      ),
    };
    const oversizedFrame = parseControlFrame(JSON.stringify(okResponse(requestId, oversized)));
    if (!oversizedFrame.ok || oversizedFrame.frame.type !== 'response')
      throw new Error('Expected a response frame');
    expect(sessionGitSnapshotResultSchema.safeParse(oversizedFrame.frame.result).success).toBe(
      false
    );
  });

  it('rejects binary and malformed frames with generic errors and no payload logging', () => {
    const logs = (['error', 'warn', 'log'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    try {
      expect(parseControlFrame(new ArrayBuffer(4))).toEqual({
        ok: false,
        error: { code: 'protocol_error', message: 'Binary frames are not supported' },
      });
      expect(parseControlFrame('{"private-body":')).toEqual({
        ok: false,
        error: { code: 'protocol_error', message: 'Frame is not valid JSON' },
      });
      for (const frame of [
        { type: 'response', requestId: 'request_1', ok: 'true', result: 'private-body' },
        { type: 'response', requestId: '', ok: true, result: 'private-body' },
        {
          type: 'response',
          requestId: 'request_1',
          ok: false,
          error: { code: 'failure', message: 'private-body' },
        },
        {
          type: 'response',
          requestId: 'request_1',
          ok: false,
          error: { code: 'failure', message: {}, retryable: false },
        },
      ]) {
        expect(parseControlFrame(JSON.stringify(frame))).toEqual({
          ok: false,
          error: { code: 'protocol_error', message: 'Frame does not match the control envelope' },
        });
      }
      expect(
        parseOperationPayload('session.git.snapshot', { revision: 1, patch: 'private-body' })
      ).toEqual({
        ok: false,
        error: { code: 'protocol_error', message: 'Invalid session.git.snapshot payload' },
      });
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it('recognizes known operations', () => {
    expect(isControlOperation('sandbox.hello')).toBe(true);
    expect(isControlOperation('session.prompt')).toBe(true);
    expect(isControlOperation('session.git.summary')).toBe(true);
    expect(isSessionOperation('session.git.summary')).toBe(true);
    expect(isControlOperation('session.git.snapshot')).toBe(true);
    expect(isSessionOperation('session.git.snapshot')).toBe(true);
    expect(isControlOperation('http.tunnel')).toBe(false);
    for (const operation of [
      'session.terminal.create',
      'session.terminal.resize',
      'session.terminal.close',
      'session.terminal.connect',
    ]) {
      expect(isControlOperation(operation)).toBe(true);
      expect(isSessionOperation(operation)).toBe(true);
    }
    expect(isControlEvent('sandbox.ready')).toBe(true);
    expect(isControlEvent('session.event')).toBe(true);
    expect(isControlEvent('session.preparing')).toBe(true);
    expect(isControlEvent('sandbox.hello')).toBe(false);
  });

  it('accepts legacy sandbox hellos and validates optional wrapper instance identity', () => {
    const legacyPayload = {
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'sandbox_1',
    };
    const currentPayload = { ...legacyPayload, wrapperInstanceId };

    expect(SANDBOX_CONTROL_PROTOCOL_VERSION).toBe(1);
    expect(parseSandboxHelloPayload(legacyPayload)).toEqual(legacyPayload);
    expect(parseSandboxHelloPayload(currentPayload)).toEqual(currentPayload);
    expect(parseOperationPayload('sandbox.hello', currentPayload).ok).toBe(true);
    expect(
      parseOperationPayload('sandbox.hello', {
        ...legacyPayload,
        wrapperInstanceId: 'not-a-uuid',
      }).ok
    ).toBe(false);
  });

  it('preserves old socket attachments while validating optional connection identities', () => {
    const legacyAttachment = { handshakeComplete: false, acceptedAt: 0 };
    const currentAttachment = { ...legacyAttachment, connectionId, wrapperInstanceId };

    expect(sandboxControlSocketAttachmentSchema.safeParse(legacyAttachment).success).toBe(true);
    expect(sandboxControlSocketAttachmentSchema.safeParse(currentAttachment)).toMatchObject({
      success: true,
      data: currentAttachment,
    });
    expect(
      sandboxControlSocketAttachmentSchema.safeParse({
        ...legacyAttachment,
        connectionId: 'not-a-uuid',
      }).success
    ).toBe(false);
    expect(
      sandboxControlSocketAttachmentSchema.safeParse({
        ...legacyAttachment,
        wrapperInstanceId: 'not-a-uuid',
      }).success
    ).toBe(false);
  });

  it('validates known operation and event payloads', () => {
    expect(
      parseOperationPayload('session.prompt', {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hi' },
        agent: { mode: 'code', model: 'kilo' },
      }).ok
    ).toBe(true);
    expect(
      parseOperationPayload('session.prompt', {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hi' },
        agent: { mode: 'code', model: 'kilo' },
        wrapperRunId: 'run_1',
      }).ok
    ).toBe(false);
    expect(parseOperationPayload('sandbox.status', {}).ok).toBe(true);
    expect(
      parseEventPayload('sandbox.ready', { kiloReady: true, globalFeedAttached: true }).ok
    ).toBe(true);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true },
        sessions: [],
      }).ok
    ).toBe(true);
    expect(
      parseEventPayload('session.preparing', {
        version: 2,
        attemptId: 'att_1',
        triggerMessageId: 'msg_1',
        revision: 1,
        timestamp: 10,
        step: 'cloning',
        message: 'Cloning repository…',
        action: 'step_started',
        stepId: 'phase:cloning',
        kind: 'phase',
        label: 'cloning',
      }).ok
    ).toBe(true);
  });

  it('preserves an opaque gateway model in prompt and command frames', () => {
    for (const turn of [
      { type: 'prompt', prompt: 'hello' },
      { type: 'command', command: 'review', arguments: '--all changes' },
    ]) {
      const payload = {
        messageId: 'msg_1',
        turn,
        agent: { mode: 'architect', model: 'vendor/Team/Model:free~Alias', variant: 'high' },
        finalization: { autoCommit: true, condenseOnComplete: false },
      };
      expect(parseOperationPayload('session.prompt', payload)).toEqual({ ok: true, payload });
    }
  });

  it('allows model omission only for command turns without adding a default', () => {
    const payload = {
      messageId: 'msg_command',
      turn: { type: 'command', command: 'review', arguments: '' },
      agent: { mode: 'reviewer', variant: 'high' },
    };
    expect(parseOperationPayload('session.prompt', payload)).toEqual({ ok: true, payload });
    expect(
      parseOperationPayload('session.prompt', {
        ...payload,
        turn: { type: 'prompt', prompt: 'hello' },
      })
    ).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Invalid session.prompt payload' },
    });
  });

  it.each(['', ' \t\n ', null])(
    'rejects invalid explicit model %j for prompt and command turns',
    model => {
      for (const turn of [
        { type: 'prompt', prompt: 'hello' },
        { type: 'command', command: 'review', arguments: '' },
      ]) {
        expect(
          parseOperationPayload('session.prompt', {
            messageId: 'msg_1',
            turn,
            agent: { mode: 'code', model },
          }).ok
        ).toBe(false);
      }
    }
  );

  it('rejects native provider selection for model-less commands', () => {
    expect(
      parseOperationPayload('session.prompt', {
        messageId: 'msg_command',
        turn: { type: 'command', command: 'review', arguments: '' },
        agent: { mode: 'code', provider: 'anthropic' },
      }).ok
    ).toBe(false);
  });

  it.each(['session.git.summary', 'session.git.snapshot'] as const)(
    'validates %s requests without accepting a payload directory',
    operation => {
      expect(parseOperationPayload(operation, { revision: 1 })).toEqual({
        ok: true,
        payload: { revision: 1 },
      });
      expect(
        parseOperationPayload(operation, {
          revision: 2,
          baseRef: 'refs/remotes/origin/main',
        }).ok
      ).toBe(true);
      for (const payload of [
        {},
        { revision: 0 },
        { revision: 1.5 },
        { revision: Number.MAX_SAFE_INTEGER + 1 },
        { revision: 1, baseRef: '--help' },
        { revision: 1, baseRef: 'main\0suffix' },
        { revision: 1, baseRef: 'x'.repeat(1025) },
        { revision: 1, directory: '/outside' },
      ]) {
        expect(parseOperationPayload(operation, payload)).toEqual({
          ok: false,
          error: { code: 'protocol_error', message: `Invalid ${operation} payload` },
        });
      }
    }
  );

  it('accepts a full sandbox.heartbeat payload', () => {
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'active',
        activeKiloSessions: 1,
        pendingMessages: 2,
        kilo: { ready: true },
        sessions: [
          {
            kiloSessionId: 'kilo_1',
            state: 'active',
            idleForMs: 1500,
            waitingOn: 'model',
          },
        ],
      }).ok
    ).toBe(true);
  });

  it('accepts sandbox.heartbeat with an empty sessions array', () => {
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: false },
        sessions: [],
      }).ok
    ).toBe(true);
  });

  it.each([
    'feed_stale',
    'feed_reconnected',
    'feed_ended',
    'feed_failed',
    'process_exited',
    'credential_refresh_failed',
    'control_disconnected',
    'shutdown',
  ])('preserves the allowlisted unhealthy heartbeat reason %s', reason => {
    const payload = { state: 'idle', kilo: { ready: false, reason }, sessions: [] };
    expect(parseEventPayload('sandbox.heartbeat', payload)).toEqual({ ok: true, payload });
  });

  it.each(['', 'unknown', 'Error: request failed', { message: 'request failed' }, null])(
    'rejects a non-allowlisted heartbeat reason %j without echoing it',
    reason => {
      expect(
        parseEventPayload('sandbox.heartbeat', {
          state: 'idle',
          kilo: { ready: false, reason },
          sessions: [],
        })
      ).toEqual({
        ok: false,
        error: { code: 'protocol_error', message: 'Invalid sandbox.heartbeat payload' },
      });
    }
  );

  it('accepts sandbox.heartbeat waitingOn values', () => {
    for (const waitingOn of ['model', 'tool', 'finalizing'] as const) {
      expect(
        parseEventPayload('sandbox.heartbeat', {
          state: 'active',
          kilo: { ready: true },
          sessions: [
            {
              kiloSessionId: 'kilo_1',
              state: 'active',
              idleForMs: 0,
              waitingOn,
            },
          ],
        }).ok
      ).toBe(true);
    }
  });

  it('rejects sandbox.heartbeat unknown fields, missing kilo, and missing sessions', () => {
    expect(parseEventPayload('sandbox.heartbeat', { state: 'idle' }).ok).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        sessions: [],
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true },
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true },
        sessions: [],
        wrapperRunId: 'run_1',
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true, extra: true },
        sessions: [],
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'active',
        kilo: { ready: true },
        sessions: [
          {
            kiloSessionId: 'kilo_1',
            state: 'active',
            idleForMs: 0,
            wrapperRunId: 'run_1',
          },
        ],
      }).ok
    ).toBe(false);
  });

  it('accepts only bounded URL-safe PTY identifiers', () => {
    expect(terminalPtyIdSchema.safeParse('PTY_123-valid').success).toBe(true);
    expect(terminalPtyIdSchema.safeParse('a'.repeat(128)).success).toBe(true);

    for (const ptyId of ['', 'a'.repeat(129), '../pty', 'pty.id', 'pty%2Fid', 'pty id']) {
      expect(terminalPtyIdSchema.safeParse(ptyId).success).toBe(false);
    }
  });

  it('validates terminal creation identity and paired terminal dimensions', () => {
    for (const payload of [
      { operationId },
      { operationId, cols: 2, rows: 2 },
      { operationId, cols: 500, rows: 200 },
    ]) {
      expect(parseOperationPayload('session.terminal.create', payload)).toEqual({
        ok: true,
        payload,
      });
    }

    for (const payload of [
      {},
      { operationId: 'not-a-uuid' },
      { operationId, cols: 80 },
      { operationId, rows: 24 },
      { operationId, cols: 1, rows: 24 },
      { operationId, cols: 501, rows: 24 },
      { operationId, cols: 80, rows: 1 },
      { operationId, cols: 80, rows: 201 },
      { operationId, cols: 80.5, rows: 24 },
      { operationId, cols: 80, rows: 24.5 },
      { operationId, cols: 80, rows: 24, extra: true },
    ]) {
      expect(parseOperationPayload('session.terminal.create', payload).ok).toBe(false);
    }
  });

  it('validates terminal resizing identity and required bounded dimensions', () => {
    for (const payload of [
      { ptyId: 'pty_1-valid', cols: 2, rows: 2 },
      { ptyId: 'pty_1-valid', cols: 500, rows: 200 },
    ]) {
      expect(parseOperationPayload('session.terminal.resize', payload)).toEqual({
        ok: true,
        payload,
      });
    }

    const payload = { ptyId: 'pty_1-valid', cols: 80, rows: 24 };
    for (const invalidPayload of [
      { cols: 80, rows: 24 },
      { ptyId: 'pty_1-valid', rows: 24 },
      { ptyId: 'pty_1-valid', cols: 80 },
      { ...payload, ptyId: '../pty' },
      { ...payload, cols: 1 },
      { ...payload, cols: 501 },
      { ...payload, rows: 1 },
      { ...payload, rows: 201 },
      { ...payload, cols: 80.5 },
      { ...payload, rows: 24.5 },
      { ...payload, extra: true },
    ]) {
      expect(parseOperationPayload('session.terminal.resize', invalidPayload).ok).toBe(false);
    }
  });

  it('requires exactly one valid PTY identifier when closing a terminal', () => {
    const payload = { ptyId: 'pty_1-valid' };
    expect(parseOperationPayload('session.terminal.close', payload)).toEqual({
      ok: true,
      payload,
    });

    for (const invalidPayload of [{}, { ptyId: '../pty' }, { ...payload, extra: true }]) {
      expect(parseOperationPayload('session.terminal.close', invalidPayload).ok).toBe(false);
    }
  });

  it('validates terminal bridge credentials without restricting arbitrary owner identities', () => {
    const payload = {
      ownerId: 'oauth/provider:subject%2Fvalue',
      ptyId: 'pty_1-valid',
      bridgeGeneration,
      capability: terminalCapability,
    };

    expect(parseOperationPayload('session.terminal.connect', payload)).toEqual({
      ok: true,
      payload,
    });
    expect(
      parseOperationPayload('session.terminal.connect', {
        ...payload,
        ownerId: 'a'.repeat(300),
      }).ok
    ).toBe(true);

    for (const invalidPayload of [
      { ...payload, ownerId: '' },
      { ...payload, ptyId: '../pty' },
      { ...payload, bridgeGeneration: 'not-a-uuid' },
      { ...payload, capability: terminalCapability.toUpperCase() },
      { ...payload, capability: terminalCapability.slice(1) },
      { ...payload, capability: `${terminalCapability}a` },
      { ...payload, capability: `${terminalCapability.slice(1)}g` },
      { ...payload, extra: true },
    ]) {
      expect(parseOperationPayload('session.terminal.connect', invalidPayload).ok).toBe(false);
    }
  });

  it('validates create and resize results against the existing terminal PTY contract', () => {
    for (const schema of [sessionTerminalCreateResultSchema, sessionTerminalResizeResultSchema]) {
      expect(schema.safeParse({ pty: terminalPty }).success).toBe(true);
      expect(schema.safeParse({ pty: { ...terminalPty, status: 'exited' } }).success).toBe(true);

      for (const result of [
        {},
        { pty: { ...terminalPty, id: '../pty' } },
        { pty: { ...terminalPty, args: [1] } },
        { pty: { ...terminalPty, status: 'closed' } },
        { pty: { ...terminalPty, pid: 1.5 } },
        { pty: { ...terminalPty, pid: undefined } },
        { pty: terminalPty, extra: true },
      ]) {
        expect(schema.safeParse(result).success).toBe(false);
      }
    }
  });

  it('validates terminal close and connect result contracts', () => {
    expect(sessionTerminalCloseResultSchema.safeParse({ success: true }).success).toBe(true);
    expect(sessionTerminalCloseResultSchema.safeParse({ success: false }).success).toBe(true);
    expect(sessionTerminalCloseResultSchema.safeParse({ success: 'true' }).success).toBe(false);
    expect(sessionTerminalCloseResultSchema.safeParse({ success: true, extra: true }).success).toBe(
      false
    );

    expect(sessionTerminalConnectResultSchema.safeParse({ connected: true }).success).toBe(true);
    expect(sessionTerminalConnectResultSchema.safeParse({ connected: false }).success).toBe(false);
    expect(
      sessionTerminalConnectResultSchema.safeParse({ connected: true, extra: true }).success
    ).toBe(false);
  });

  it('builds response envelopes without logging payloads', () => {
    expect(okResponse('req_1', { handshakeComplete: true })).toEqual({
      type: 'response',
      requestId: 'req_1',
      ok: true,
      result: { handshakeComplete: true },
    });
    expect(errorResponse('req_1', 'protocol_error', 'bad', false)).toEqual({
      type: 'response',
      requestId: 'req_1',
      ok: false,
      error: { code: 'protocol_error', message: 'bad', retryable: false },
    });
  });
});
