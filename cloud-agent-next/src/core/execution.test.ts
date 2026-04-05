import { describe, it, expect } from 'vitest';
import { canTransition, isTerminal, getAllowedTransitions } from './execution.js';

describe('Execution State Machine', () => {
  describe('canTransition', () => {
    it('should allow pending -> running', () => {
      expect(canTransition('pending', 'running')).toBe(true);
    });

    it('should allow pending -> failed (for expired queue entries)', () => {
      expect(canTransition('pending', 'failed')).toBe(true);
    });

    it('should allow running -> completed', () => {
      expect(canTransition('running', 'completed')).toBe(true);
    });

    it('should allow running -> failed', () => {
      expect(canTransition('running', 'failed')).toBe(true);
    });

    it('should allow running -> interrupted', () => {
      expect(canTransition('running', 'interrupted')).toBe(true);
    });

    it('should not allow pending -> completed (must go through running)', () => {
      expect(canTransition('pending', 'completed')).toBe(false);
    });

    it('should not allow completed -> running (terminal state)', () => {
      expect(canTransition('completed', 'running')).toBe(false);
    });

    it('should not allow failed -> running (terminal state)', () => {
      expect(canTransition('failed', 'running')).toBe(false);
    });

    it('should not allow interrupted -> running (terminal state)', () => {
      expect(canTransition('interrupted', 'running')).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it('should return false for pending', () => {
      expect(isTerminal('pending')).toBe(false);
    });

    it('should return false for running', () => {
      expect(isTerminal('running')).toBe(false);
    });

    it('should return true for completed', () => {
      expect(isTerminal('completed')).toBe(true);
    });

    it('should return true for failed', () => {
      expect(isTerminal('failed')).toBe(true);
    });

    it('should return true for interrupted', () => {
      expect(isTerminal('interrupted')).toBe(true);
    });
  });

  describe('getAllowedTransitions', () => {
    it('should return [running, failed] for pending', () => {
      expect(getAllowedTransitions('pending')).toEqual(['running', 'failed']);
    });

    it('should return [completed, failed, interrupted] for running', () => {
      expect(getAllowedTransitions('running')).toEqual(['completed', 'failed', 'interrupted']);
    });

    it('should return empty array for terminal states', () => {
      expect(getAllowedTransitions('completed')).toEqual([]);
      expect(getAllowedTransitions('failed')).toEqual([]);
      expect(getAllowedTransitions('interrupted')).toEqual([]);
    });
  });
});
