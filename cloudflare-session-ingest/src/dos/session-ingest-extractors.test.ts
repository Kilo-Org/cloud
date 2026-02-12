import { describe, it, expect } from 'vitest';
import type { IngestBatch } from '../types/session-sync';
import {
  extractNormalizedTitleFromItem,
  extractNormalizedParentIdFromItem,
  extractNormalizedPlatformFromItem,
  extractNormalizedOrgIdFromItem,
} from './session-ingest-extractors';

function sessionItem(data: Record<string, unknown>): IngestBatch[number] {
  return { type: 'session', data } as IngestBatch[number];
}

function kiloMetaItem(data: { platform: string; orgId?: string }): IngestBatch[number] {
  return { type: 'kilo_meta', data } as IngestBatch[number];
}

function messageItem(): IngestBatch[number] {
  return { type: 'message', data: { id: 'msg-1' } } as IngestBatch[number];
}

describe('extractNormalizedTitleFromItem', () => {
  it('extracts title from session item', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: 'My Session' }))).toBe('My Session');
  });

  it('trims whitespace from title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: '  hello  ' }))).toBe('hello');
  });

  it('returns null for empty string title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: '' }))).toBeNull();
  });

  it('returns null for whitespace-only title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: '   ' }))).toBeNull();
  });

  it('returns undefined for session item with no title field', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({}))).toBeUndefined();
  });

  it('returns undefined for non-session item', () => {
    expect(extractNormalizedTitleFromItem(messageItem())).toBeUndefined();
  });

  it('returns null for null title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: null }))).toBeNull();
  });

  it('returns undefined for numeric title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: 42 }))).toBeUndefined();
  });
});

describe('extractNormalizedParentIdFromItem', () => {
  it('extracts parentID from session item', () => {
    expect(extractNormalizedParentIdFromItem(sessionItem({ parentID: 'parent-1' }))).toBe(
      'parent-1'
    );
  });

  it('returns null for empty parentID', () => {
    expect(extractNormalizedParentIdFromItem(sessionItem({ parentID: '' }))).toBeNull();
  });

  it('returns undefined for session item with no parentID', () => {
    expect(extractNormalizedParentIdFromItem(sessionItem({}))).toBeUndefined();
  });

  it('returns undefined for non-session item', () => {
    expect(extractNormalizedParentIdFromItem(messageItem())).toBeUndefined();
  });
});

describe('extractNormalizedPlatformFromItem', () => {
  it('extracts platform from kilo_meta item', () => {
    expect(extractNormalizedPlatformFromItem(kiloMetaItem({ platform: 'vscode' }))).toBe('vscode');
  });

  it('returns undefined for non-kilo_meta item', () => {
    expect(extractNormalizedPlatformFromItem(sessionItem({}))).toBeUndefined();
  });

  it('trims whitespace from platform', () => {
    expect(extractNormalizedPlatformFromItem(kiloMetaItem({ platform: '  cli  ' }))).toBe('cli');
  });
});

describe('extractNormalizedOrgIdFromItem', () => {
  it('extracts orgId from kilo_meta item', () => {
    expect(
      extractNormalizedOrgIdFromItem(kiloMetaItem({ platform: 'cli', orgId: 'org-123' }))
    ).toBe('org-123');
  });

  it('returns undefined for kilo_meta item without orgId', () => {
    expect(extractNormalizedOrgIdFromItem(kiloMetaItem({ platform: 'cli' }))).toBeUndefined();
  });

  it('returns undefined for non-kilo_meta item', () => {
    expect(extractNormalizedOrgIdFromItem(messageItem())).toBeUndefined();
  });
});
