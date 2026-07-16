import { type KiloSessionId, type StoredMessage, type ToolPart } from 'cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  getChildSessionActivityLabel,
  getChildSessionCardState,
  getTaskToolSessionId,
} from './child-session-card-state';

const subagentSessionId = 'ses-child' as KiloSessionId;

function makeToolPart(tool: string, state: ToolPart['state']): ToolPart {
  return {
    id: 'p1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    tool,
    callID: 'call-1',
    state,
  };
}

function makeTaskPart(
  status: 'pending' | 'running' | 'completed' | 'error',
  input: Record<string, unknown> = {}
): ToolPart {
  if (status === 'pending') {
    return makeToolPart('task', { status: 'pending', input, raw: '' });
  }
  if (status === 'running') {
    return makeToolPart('task', {
      status: 'running',
      input,
      time: { start: 1 },
      metadata: { sessionId: subagentSessionId },
    });
  }
  if (status === 'completed') {
    return makeToolPart('task', {
      status: 'completed',
      input,
      output: 'done',
      title: 'Task',
      metadata: { sessionId: subagentSessionId },
      time: { start: 1, end: 2 },
    });
  }
  return makeToolPart('task', {
    status: 'error',
    input,
    error: 'failed',
    metadata: { sessionId: subagentSessionId },
    time: { start: 1, end: 2 },
  });
}

function makeAssistantMessage(parts: ToolPart[], id = 'msg-1'): StoredMessage {
  return {
    info: {
      id,
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'msg-0',
      modelID: 'claude',
      providerID: 'anthropic',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

describe('getChildSessionCardState', () => {
  it('falls back to Subagent / Task / Waiting for activity for a pending task with empty input', () => {
    const part = makeTaskPart('pending');
    expect(getChildSessionCardState(part, [])).toEqual({
      agentName: 'Subagent',
      taskName: 'Task',
      latestActivity: 'Waiting for activity',
    });
  });

  it('uses subagent_type and description from input', () => {
    const part = makeTaskPart('pending', { subagent_type: 'Coder', description: 'Refactor auth' });
    expect(getChildSessionCardState(part, [])).toEqual({
      agentName: 'Coder',
      taskName: 'Refactor auth',
      latestActivity: 'Waiting for activity',
    });
  });

  it('truncates prompt when description is absent', () => {
    const part = makeTaskPart('pending', { prompt: 'a'.repeat(100) });
    const state = getChildSessionCardState(part, []);
    expect(state.taskName).toBe(`${'a'.repeat(60)}\u2026`);
  });

  it('reads a completed read tool from child messages and derives its filename context', () => {
    const part = makeTaskPart('running', {
      subagent_type: 'Researcher',
      description: 'Check spec',
    });
    const readPart = makeToolPart('read', {
      status: 'completed',
      input: { filePath: '/project/docs/spec.md' },
      output: 'content',
      title: 'read',
      metadata: {},
      time: { start: 1, end: 2 },
    });
    const messages = [makeAssistantMessage([readPart])];
    expect(getChildSessionCardState(part, messages)).toEqual({
      agentName: 'Researcher',
      taskName: 'Check spec',
      latestActivity: { tool: 'read', context: 'spec.md' },
    });
  });

  it('keeps the latest completed or errored tool when it supersedes an older running tool', () => {
    const part = makeTaskPart('running', { subagent_type: 'Builder', description: 'Fix bug' });
    const olderRunningTool = makeToolPart('bash', {
      status: 'running',
      input: { command: 'git status' },
      time: { start: 1 },
      metadata: {},
    });
    const newerCompletedTool = makeToolPart('edit', {
      status: 'completed',
      input: { filePath: '/project/src/auth.ts' },
      output: 'done',
      title: 'edit',
      metadata: {},
      time: { start: 2, end: 3 },
    });
    const messages = [makeAssistantMessage([olderRunningTool, newerCompletedTool])];
    expect(getChildSessionCardState(part, messages)).toEqual({
      agentName: 'Builder',
      taskName: 'Fix bug',
      latestActivity: { tool: 'edit', context: 'auth.ts' },
    });
  });

  it('retains latest activity from a newer errored tool over an older running tool', () => {
    const part = makeTaskPart('running', { subagent_type: 'Tester', description: 'Run tests' });
    const olderRunningTool = makeToolPart('bash', {
      status: 'running',
      input: { command: 'npm test' },
      time: { start: 1 },
      metadata: {},
    });
    const newerErrorTool = makeToolPart('glob', {
      status: 'error',
      input: { pattern: '**/*.test.tsx' },
      error: 'not found',
      time: { start: 2, end: 3 },
    });
    const messages = [makeAssistantMessage([olderRunningTool, newerErrorTool])];
    expect(getChildSessionCardState(part, messages)).toEqual({
      agentName: 'Tester',
      taskName: 'Run tests',
      latestActivity: { tool: 'glob', context: '**/*.test.tsx' },
    });
  });

  it('scans messages from newest to oldest, preferring the latest assistant message', () => {
    const part = makeTaskPart('running', { subagent_type: 'Agent', description: 'Find files' });
    const newestTool = makeToolPart('grep', {
      status: 'completed',
      input: { pattern: 'handler' },
      output: 'matches',
      title: 'grep',
      metadata: {},
      time: { start: 3, end: 4 },
    });
    const oldestTool = makeToolPart('read', {
      status: 'running',
      input: { filePath: '/project/README.md' },
      time: { start: 1 },
      metadata: {},
    });
    const messages = [
      makeAssistantMessage([oldestTool], 'msg-1'),
      makeAssistantMessage([newestTool], 'msg-2'),
    ];
    expect(getChildSessionCardState(part, messages)).toEqual({
      agentName: 'Agent',
      taskName: 'Find files',
      latestActivity: { tool: 'grep', context: 'handler' },
    });
  });

  it('truncates long bash commands to the first 20 characters', () => {
    const part = makeTaskPart('running', { subagent_type: 'Shell', description: 'Deploy' });
    const bashTool = makeToolPart('bash', {
      status: 'running',
      input: { command: 'very-long-command-name --flag value' },
      time: { start: 1 },
      metadata: {},
    });
    const messages = [makeAssistantMessage([bashTool])];
    const state = getChildSessionCardState(part, messages);
    expect(state.latestActivity).toEqual({
      tool: 'bash',
      context: 'very-long-command-na\u2026',
    });
  });

  it('truncates long glob patterns to 25 characters', () => {
    const part = makeTaskPart('running', { subagent_type: 'Finder', description: 'Locate' });
    const globTool = makeToolPart('glob', {
      status: 'running',
      input: { pattern: 'src/components/**/*.test.tsx' },
      time: { start: 1 },
      metadata: {},
    });
    const messages = [makeAssistantMessage([globTool])];
    const state = getChildSessionCardState(part, messages);
    expect(state.latestActivity).toEqual({
      tool: 'glob',
      context: 'src/components/**/*.test.\u2026',
    });
  });

  it('truncates long nested task descriptions to 30 characters', () => {
    const part = makeTaskPart('running', { subagent_type: 'Planner', description: 'Plan' });
    const nestedTaskTool = makeToolPart('task', {
      status: 'running',
      input: { description: 'This is a very long nested task description indeed' },
      time: { start: 1 },
      metadata: {},
    });
    const messages = [makeAssistantMessage([nestedTaskTool])];
    const state = getChildSessionCardState(part, messages);
    expect(state.latestActivity).toEqual({
      tool: 'task',
      context: 'This is a very long nested tas\u2026',
    });
  });

  it('includes non-assistant messages without throwing, ignoring them for activity', () => {
    const part = makeTaskPart('pending', { subagent_type: 'Helper', description: 'Help' });
    const userMessage: StoredMessage = {
      info: {
        id: 'msg-user',
        sessionID: 'ses-1',
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'a', modelID: 'b' },
      },
      parts: [],
    };
    expect(getChildSessionCardState(part, [userMessage])).toEqual({
      agentName: 'Helper',
      taskName: 'Help',
      latestActivity: 'Waiting for activity',
    });
  });
});

describe('getChildSessionActivityLabel', () => {
  it('returns the activity string with context when present', () => {
    expect(getChildSessionActivityLabel({ tool: 'read', context: 'spec.md' })).toBe('read spec.md');
  });

  it('returns the tool name when no context is present', () => {
    expect(getChildSessionActivityLabel({ tool: 'bash' })).toBe('bash');
  });

  it('passes through the waiting text unchanged', () => {
    expect(getChildSessionActivityLabel('Waiting for activity')).toBe('Waiting for activity');
  });
});

describe('getTaskToolSessionId', () => {
  it('returns undefined for a pending task with no metadata', () => {
    const part = makeTaskPart('pending');
    expect(getTaskToolSessionId(part)).toBeUndefined();
  });

  it('returns the session id from a running task metadata', () => {
    const part = makeTaskPart('running');
    expect(getTaskToolSessionId(part)).toBe(subagentSessionId);
  });

  it('returns the session id from a completed task metadata', () => {
    const part = makeTaskPart('completed');
    expect(getTaskToolSessionId(part)).toBe(subagentSessionId);
  });

  it('returns the session id from an errored task metadata', () => {
    const part = makeTaskPart('error');
    expect(getTaskToolSessionId(part)).toBe(subagentSessionId);
  });

  it('returns undefined for non-task tools', () => {
    const readPart = makeToolPart('read', {
      status: 'completed',
      input: { filePath: 'x' },
      output: 'y',
      title: 'read',
      metadata: {},
      time: { start: 1, end: 2 },
    });
    expect(getTaskToolSessionId(readPart)).toBeUndefined();
  });
});
