import { describe, it, expect } from 'vitest';
import { Ok, Err, isOk, isErr, mapResult, unwrap, unwrapOr } from './result.js';

describe('Result Type', () => {
  describe('Ok', () => {
    it('should create a success result', () => {
      const result = Ok(42);
      expect(result).toEqual({ ok: true, value: 42 });
    });
  });

  describe('Err', () => {
    it('should create an error result', () => {
      const result = Err('error message');
      expect(result).toEqual({ ok: false, error: 'error message' });
    });
  });

  describe('isOk', () => {
    it('should return true for Ok results', () => {
      expect(isOk(Ok(42))).toBe(true);
    });

    it('should return false for Err results', () => {
      expect(isOk(Err('error'))).toBe(false);
    });
  });

  describe('isErr', () => {
    it('should return true for Err results', () => {
      expect(isErr(Err('error'))).toBe(true);
    });

    it('should return false for Ok results', () => {
      expect(isErr(Ok(42))).toBe(false);
    });
  });

  describe('mapResult', () => {
    it('should apply function to Ok value', () => {
      const result = mapResult(Ok(21), x => x * 2);
      expect(result).toEqual(Ok(42));
    });

    it('should pass through Err unchanged', () => {
      const result = mapResult(Err('error'), (x: number) => x * 2);
      expect(result).toEqual(Err('error'));
    });
  });

  describe('unwrap', () => {
    it('should return value for Ok results', () => {
      expect(unwrap(Ok(42))).toBe(42);
    });

    it('should throw for Err results with string error', () => {
      expect(() => unwrap(Err('error'))).toThrow('error');
    });

    it('should throw the original error for Err results with Error instance', () => {
      const error = new Error('test error');
      expect(() => unwrap(Err(error))).toThrow(error);
    });
  });

  describe('unwrapOr', () => {
    it('should return value for Ok results', () => {
      expect(unwrapOr(Ok(42), 0)).toBe(42);
    });

    it('should return default for Err results', () => {
      expect(unwrapOr(Err('error'), 0)).toBe(0);
    });
  });
});
