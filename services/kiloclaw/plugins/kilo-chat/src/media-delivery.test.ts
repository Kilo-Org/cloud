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

  it('resolves relative paths against the agent working dir, not the OpenClaw workspace', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'kilo-chat-agent-'));
    const openclawWorkspace = await mkdtemp(join(tmpdir(), 'kilo-chat-ws-'));
    const previousCwd = process.cwd();
    try {
      await writeFile(join(agentDir, 'report.md'), '# Weekly Report');
      process.chdir(agentDir);

      const media = await loadOutboundMedia('report.md', {
        mediaAccess: {
          localRoots: [openclawWorkspace],
          workspaceDir: openclawWorkspace,
          readFile: async path => Buffer.from(await readFile(path)),
        },
      });

      expect(media.buffer.toString('utf8')).toBe('# Weekly Report');
      expect(media.fileName).toBe('report.md');
    } finally {
      process.chdir(previousCwd);
      await rm(agentDir, { recursive: true, force: true });
      await rm(openclawWorkspace, { recursive: true, force: true });
    }
  });

  it('resolves relative filenames containing colons against the agent working dir', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'kilo-chat-agent-'));
    const openclawWorkspace = await mkdtemp(join(tmpdir(), 'kilo-chat-ws-'));
    const previousCwd = process.cwd();
    try {
      await writeFile(join(agentDir, 'report:2026-07-03.md'), '# Weekly Report');
      process.chdir(agentDir);

      const media = await loadOutboundMedia('report:2026-07-03.md', {
        mediaAccess: {
          localRoots: [openclawWorkspace],
          workspaceDir: openclawWorkspace,
          readFile: async path => Buffer.from(await readFile(path)),
        },
      });

      expect(media.buffer.toString('utf8')).toBe('# Weekly Report');
      expect(media.fileName).toBe('report:2026-07-03.md');
    } finally {
      process.chdir(previousCwd);
      await rm(agentDir, { recursive: true, force: true });
      await rm(openclawWorkspace, { recursive: true, force: true });
    }
  });

  it('allows files under the agent working dir even when it is outside the configured local roots', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'kilo-chat-agent-'));
    const openclawWorkspace = await mkdtemp(join(tmpdir(), 'kilo-chat-ws-'));
    const previousCwd = process.cwd();
    try {
      const filePath = join(agentDir, 'report.md');
      await writeFile(filePath, '# Weekly Report');
      process.chdir(agentDir);

      // No readFile → exercises the real OpenClaw loader and its local-roots gating.
      const media = await loadOutboundMedia(filePath, {
        mediaAccess: {
          localRoots: [openclawWorkspace],
          workspaceDir: openclawWorkspace,
        },
      });

      expect(media.buffer.toString('utf8')).toBe('# Weekly Report');
      expect(media.contentType).toBe('text/markdown');
      expect(media.fileName).toBe('report.md');
    } finally {
      process.chdir(previousCwd);
      await rm(agentDir, { recursive: true, force: true });
      await rm(openclawWorkspace, { recursive: true, force: true });
    }
  });

  it('passes custom mediaReadFile through to the OpenClaw media loader', async () => {
    const media = await loadOutboundMedia('/virtual/generated.txt', {
      mediaLocalRoots: 'any',
      mediaReadFile: async filePath => {
        expect(filePath).toBe('/virtual/generated.txt');
        return Buffer.from('virtual plain text attachment');
      },
    });

    expect(media.buffer.toString('utf8')).toBe('virtual plain text attachment');
    expect(media.contentType).toBe('text/plain');
    expect(media.fileName).toBe('generated.txt');
  });
});
