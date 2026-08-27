import { describe, expect, it } from 'vitest';
import { bootPreparingStep, provisionPreparingStep } from '../preparing-steps.js';

describe('create and boot preparing steps', () => {
  it('emits sandbox_provision then sandbox_boot before attach', () => {
    expect(provisionPreparingStep('stopped', true)).toEqual({
      step: 'sandbox_provision',
      message: 'Creating sandbox…',
    });
    expect(provisionPreparingStep('stopped', false)).toBeNull();
    expect(provisionPreparingStep('running', true)).toBeNull();

    expect(bootPreparingStep('creating', 'disconnected')).toEqual({
      step: 'sandbox_boot',
      message: 'Starting environment…',
    });
    expect(bootPreparingStep('running', 'connected')).toEqual({
      step: 'sandbox_boot',
      message: 'Starting environment…',
    });
    expect(bootPreparingStep('running', 'ready')).toBeNull();
  });
});
