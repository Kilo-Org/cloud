import { describe, expect, it } from 'vitest';
import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';
import { startCommandsForWrapper } from './start-commands.js';

const spec: ControlPlaneRouteSpec = {
  sessionId: 'ses_a',
  kiloSessionId: 'kilo_a',
  attemptId: 'attempt-1',
  directory: '/workspace',
  setupCommands: ['install'],
  startCommands: ['serve'],
};

describe('startCommandsForWrapper', () => {
  it('keeps start commands apart for a wrapper that runs them', () => {
    expect(startCommandsForWrapper(spec, true)).toBe(spec);
  });

  it('appends start commands to setup for a wrapper that predates them', () => {
    const result = startCommandsForWrapper(spec, false);
    expect(result.setupCommands).toEqual(['install', 'serve']);
    expect(result).not.toHaveProperty('startCommands');
  });

  it('leaves setup untouched for an older wrapper when there are no start commands', () => {
    const result = startCommandsForWrapper({ ...spec, startCommands: undefined }, false);
    expect(result.setupCommands).toEqual(['install']);
    expect(result).not.toHaveProperty('startCommands');
  });
});
