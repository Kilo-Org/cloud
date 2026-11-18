import { describe, expect, it } from '@jest/globals';
import type { CloudAgentAttachmentFile } from '@/hooks/useCloudAgentAttachmentUpload';
import {
  COMPOSER_SNAPSHOT_LIMIT,
  saveComposerSnapshot,
  takeComposerSnapshot,
  type ComposerSnapshot,
} from './composer-snapshots';

function draft(text: string, attachments: CloudAgentAttachmentFile[] = []): ComposerSnapshot {
  return { text, attachments };
}

function attachment(id: string): CloudAgentAttachmentFile {
  return {
    id,
    file: new File(['x'], `${id}.png`, { type: 'image/png' }),
    contentType: 'image/png',
    kind: 'image',
    previewUrl: `blob:${id}`,
    status: 'complete',
    progress: 100,
  };
}

function fill(snapshots: Map<string, ComposerSnapshot>, count: number) {
  for (let index = 0; index < count; index++) {
    saveComposerSnapshot(snapshots, `chat-${index}`, draft(`draft ${index}`), () => false);
  }
}

describe('saveComposerSnapshot', () => {
  it('drops an empty draft instead of keeping an entry for it', () => {
    const snapshots = new Map<string, ComposerSnapshot>();
    saveComposerSnapshot(snapshots, 'a', draft('hello'), () => false);
    saveComposerSnapshot(snapshots, 'a', draft(''), () => false);
    expect(snapshots.has('a')).toBe(false);
  });

  it('evicts the oldest draft beyond the limit and returns it', () => {
    const snapshots = new Map<string, ComposerSnapshot>();
    fill(snapshots, COMPOSER_SNAPSHOT_LIMIT);
    const oldest = snapshots.get('chat-0');

    const evicted = saveComposerSnapshot(snapshots, 'new', draft('newest'), () => false);

    expect(evicted).toEqual([oldest]);
    expect(snapshots.size).toBe(COMPOSER_SNAPSHOT_LIMIT);
    expect(snapshots.has('chat-0')).toBe(false);
    expect(snapshots.has('new')).toBe(true);
  });

  it('treats a re-saved draft as the newest entry', () => {
    const snapshots = new Map<string, ComposerSnapshot>();
    fill(snapshots, COMPOSER_SNAPSHOT_LIMIT);
    saveComposerSnapshot(snapshots, 'chat-0', draft('edited'), () => false);

    saveComposerSnapshot(snapshots, 'new', draft('newest'), () => false);

    expect(snapshots.has('chat-0')).toBe(true);
    expect(snapshots.has('chat-1')).toBe(false);
  });

  it('never evicts a protected conversation or the draft being saved', () => {
    const snapshots = new Map<string, ComposerSnapshot>();
    fill(snapshots, COMPOSER_SNAPSHOT_LIMIT);
    const sending = draft('sending', [attachment('in-flight')]);
    saveComposerSnapshot(snapshots, 'chat-0', sending, () => false);

    const evicted = saveComposerSnapshot(
      snapshots,
      'new',
      draft('newest'),
      key => key === 'chat-1' || key === 'chat-0'
    );

    expect(snapshots.get('chat-0')).toBe(sending);
    expect(snapshots.has('chat-1')).toBe(true);
    expect(snapshots.has('chat-2')).toBe(false);
    expect(evicted).toHaveLength(1);
  });

  it('exceeds the limit rather than evict when every older draft is protected', () => {
    const snapshots = new Map<string, ComposerSnapshot>();
    fill(snapshots, COMPOSER_SNAPSHOT_LIMIT);

    const evicted = saveComposerSnapshot(snapshots, 'new', draft('newest'), () => true);

    expect(evicted).toEqual([]);
    expect(snapshots.size).toBe(COMPOSER_SNAPSHOT_LIMIT + 1);
  });
});

describe('takeComposerSnapshot', () => {
  it('hands the draft to the live composer and removes it from the store', () => {
    const snapshots = new Map<string, ComposerSnapshot>();
    const saved = draft('restore me', [attachment('kept')]);
    saveComposerSnapshot(snapshots, 'a', saved, () => false);

    expect(takeComposerSnapshot(snapshots, 'a')).toBe(saved);
    expect(snapshots.has('a')).toBe(false);
    expect(takeComposerSnapshot(snapshots, 'a')).toBeUndefined();
  });
});
