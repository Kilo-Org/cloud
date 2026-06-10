/**
 * Execution-ID removal compliance gate.
 *
 * Verifies that dead execution-ID patterns have been fully removed:
 *   - ExecutionBinding type in wrapper-client.ts
 *   - execution field on WrapperPromptOptions / WrapperCommandOptions
 *   - executionId on PendingSessionMessage schema
 *   - execution-lifecycle.ts file
 *   - createPendingSessionMessageFromPlan, enqueuePendingSessionMessage in session-message-queue
 *   - buildExecutionPlan, queueExecutionPlan in CloudAgentSession
 *   - isNewPath branching in executeDirectly
 *   - message.executionId references in CloudAgentSession
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const BASE = resolve(join(__dirname, '..'));

describe('execution-id removal compliance gate', () => {
  const noSuchFile = (path: string) => {
    try {
      readFileSync(join(BASE, path));
      return false;
    } catch {
      return true;
    }
  };
  const fileContains = (path: string, pattern: RegExp) => {
    try {
      return pattern.test(readFileSync(join(BASE, path), 'utf-8'));
    } catch {
      return false;
    }
  };

  it('execution-lifecycle.ts is deleted', () => {
    expect(noSuchFile('src/session/ingest-handlers/execution-lifecycle.ts')).toBe(true);
  });

  it('ingest-handlers index does not re-export execution-lifecycle', () => {
    expect(fileContains('src/session/ingest-handlers/index.ts', /execution-lifecycle/)).toBe(false);
  });

  it('ExecutionBinding type is removed from wrapper-client', () => {
    expect(fileContains('src/kilo/wrapper-client.ts', /ExecutionBinding/)).toBe(false);
  });

  it('wrapper-client options do not have execution field', () => {
    expect(fileContains('src/kilo/wrapper-client.ts', /execution\?:\s*ExecutionBinding/)).toBe(
      false
    );
  });

  it('PendingSessionMessageSchema does not have executionId', () => {
    const content = readFileSync(join(BASE, 'src/session/pending-messages.ts'), 'utf-8');
    const schemaSection = content.substring(content.indexOf('PendingSessionMessageSchema'));
    expect(schemaSection).not.toContain('executionId: z.string()');
  });

  it('createPendingSessionMessage does not have executionId param', () => {
    const content = readFileSync(join(BASE, 'src/session/pending-messages.ts'), 'utf-8');
    const fnMatch = content.match(/function createPendingSessionMessage\(params: \{([^}]+)\}/);
    expect(fnMatch?.[1]).not.toContain('executionId');
  });

  it('recordPendingFlushFailure does not log executionId', () => {
    const content = readFileSync(join(BASE, 'src/session/pending-messages.ts'), 'utf-8');
    const fnContent = content.substring(content.indexOf('function recordPendingFlushFailure'));
    const consoleWarnSection = fnContent.substring(0, fnContent.indexOf('const attempts'));
    expect(consoleWarnSection).not.toContain('message.executionId');
  });

  it('createPendingSessionMessageFromPlan is removed from session-message-queue', () => {
    expect(
      fileContains('src/session/session-message-queue.ts', /createPendingSessionMessageFromPlan/)
    ).toBe(false);
  });

  it('enqueuePendingSessionMessage is removed from session-message-queue', () => {
    expect(
      fileContains(
        'src/session/session-message-queue.ts',
        /^export async function enqueuePendingSessionMessage\b/m
      )
    ).toBe(false);
  });

  it('buildExecutionPlan is removed from CloudAgentSession', () => {
    expect(fileContains('src/persistence/CloudAgentSession.ts', /buildExecutionPlan/)).toBe(false);
  });

  it('queueExecutionPlan is removed from CloudAgentSession', () => {
    expect(fileContains('src/persistence/CloudAgentSession.ts', /queueExecutionPlan/)).toBe(false);
  });

  it('message.executionId references are removed from CloudAgentSession', () => {
    expect(fileContains('src/persistence/CloudAgentSession.ts', /message\.executionId/)).toBe(
      false
    );
  });

  it('isNewPath branching is removed from CloudAgentSession', () => {
    expect(fileContains('src/persistence/CloudAgentSession.ts', /isNewPath/)).toBe(false);
  });

  it('enqueuePendingSessionMessage is removed from CloudAgentSession imports', () => {
    const content = readFileSync(join(BASE, 'src/persistence/CloudAgentSession.ts'), 'utf-8');
    const importBlock = content.substring(
      content.indexOf("from '../session/session-message-queue.js'"),
      content.indexOf("from '../session/session-message-queue.js'") + 200
    );
    expect(importBlock).not.toContain('enqueuePendingSessionMessage,');
  });

  it('execution field is removed from orchestrator WrapperPromptOptions', () => {
    const content = readFileSync(join(BASE, 'src/execution/orchestrator.ts'), 'utf-8');
    expect(content).not.toMatch(/^ {6}execution,$/m);
  });

  it('wrapper readiness and grouped prompt requests include session binding', () => {
    const content = readFileSync(join(BASE, 'src/session-service.ts'), 'utf-8');
    expect(content).toContain('const session = buildWrapperSessionBinding');
    expect(content).toMatch(
      /const readyRequest: WrapperSessionReadyRequest = \{[\s\S]*\n {6}session,\n/
    );
    expect(content).toContain('const promptRequest: WrapperPromptRequest = {');
    expect(content).toContain('message: {');
    expect(content).toContain('id: turn.messageId');
    expect(content).toContain('agent: {');
    expect(content).toContain('mode: promptAgent');
    expect(content).toContain('finalization: {');
    expect(content).toMatch(
      /const promptRequest: WrapperPromptRequest = \{[\s\S]*\n {6}session,\n/
    );
  });

  it('wrapper server exposes session readiness instead of composite execution', () => {
    const content = readFileSync(join(BASE, 'wrapper/src/server.ts'), 'utf-8');
    expect(content).toContain("'/session/ready'");
    expect(content).not.toContain("'/session/execute'");
  });

  it('SessionBinding type requires wrapper identity fields', () => {
    const content = readFileSync(join(BASE, 'src/kilo/wrapper-client.ts'), 'utf-8');
    const match = content.match(/export type SessionBinding = \{([^}]+)\}/);
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toContain('wrapperRunId: string');
    expect(body).toContain('wrapperGeneration: number');
    expect(body).toContain('wrapperConnectionId: string');
  });
});
