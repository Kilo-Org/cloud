import { describe, expect, it } from 'vitest';

import {
  cancelPendingScroll,
  decideOnItemsChange,
  decideOnScrollRequest,
} from './pending-scroll-request';

function mapOf(entries: readonly [string, number][]): Map<string, number> {
  return new Map(entries);
}

describe('pending-scroll-request', () => {
  describe('decideOnScrollRequest', () => {
    it('scrolls immediately when the target key is present', () => {
      const indexByKey = mapOf([
        ['file-header:a.ts', 0],
        ['file-header:b.ts', 5],
      ]);
      expect(decideOnScrollRequest(null, 'file-header:b.ts', indexByKey)).toEqual({
        pending: null,
        index: 5,
      });
    });

    it('parks the request when the target key is absent', () => {
      const indexByKey = mapOf([['file-header:a.ts', 0]]);
      expect(decideOnScrollRequest(null, 'file-header:missing.ts', indexByKey)).toEqual({
        pending: 'file-header:missing.ts',
        index: null,
      });
    });

    it('supersedes a prior pending key with the newer request', () => {
      const indexByKey = mapOf([['file-header:a.ts', 0]]);
      const first = decideOnScrollRequest(null, 'file-header:old.ts', indexByKey);
      expect(first.pending).toBe('file-header:old.ts');

      const second = decideOnScrollRequest(first.pending, 'file-header:new.ts', indexByKey);
      expect(second).toEqual({
        pending: 'file-header:new.ts',
        index: null,
      });
    });

    it('clears a prior pending key when the newer request can scroll now', () => {
      const indexByKey = mapOf([['file-header:ready.ts', 3]]);
      expect(
        decideOnScrollRequest('file-header:old.ts', 'file-header:ready.ts', indexByKey)
      ).toEqual({
        pending: null,
        index: 3,
      });
    });
  });

  describe('decideOnItemsChange', () => {
    it('does nothing when there is no pending request', () => {
      const indexByKey = mapOf([['file-header:a.ts', 0]]);
      expect(decideOnItemsChange(null, indexByKey)).toEqual({
        pending: null,
        index: null,
      });
    });

    it('retries and scrolls when a previously absent key becomes present', () => {
      const empty = mapOf([]);
      const parked = decideOnScrollRequest(null, 'file-header:late.ts', empty);
      expect(parked.pending).toBe('file-header:late.ts');

      const ready = mapOf([['file-header:late.ts', 12]]);
      expect(decideOnItemsChange(parked.pending, ready)).toEqual({
        pending: null,
        index: 12,
      });
    });

    it('keeps waiting while the key is still absent', () => {
      const indexByKey = mapOf([['file-header:other.ts', 1]]);
      expect(decideOnItemsChange('file-header:late.ts', indexByKey)).toEqual({
        pending: 'file-header:late.ts',
        index: null,
      });
    });
  });

  describe('cancelPendingScroll', () => {
    it('clears any pending key on unmount', () => {
      expect(cancelPendingScroll()).toBeNull();
    });
  });
});
