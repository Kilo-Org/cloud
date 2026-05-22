import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOutboundMedia } from './media-delivery';

describe('loadOutboundMedia', () => {
  it('loads text/plain files from allowed local roots without host media type gating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kilo-chat-media-'));
    try {
      const filePath = join(dir, 'random_text.txt');
      await writeFile(filePath, 'plain text attachment');

      const media = await loadOutboundMedia(filePath, {
        mediaAccess: {
          localRoots: [dir],
          workspaceDir: dir,
          readFile: async path => Buffer.from(await readFile(path)),
        },
      });

      expect(media.buffer.toString('utf8')).toBe('plain text attachment');
      expect(media.contentType).toBe('text/plain');
      expect(media.fileName).toBe('random_text.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
