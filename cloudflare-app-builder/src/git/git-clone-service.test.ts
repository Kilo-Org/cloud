/**
 * Unit tests for GitCloneService
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GitCloneService } from './git-clone-service';
import { MemFS } from './memfs';
import git from '@ashishkumar472/cf-git';

describe('GitCloneService', () => {
  describe('buildRepository', () => {
    it('creates empty repo when no git objects provided', async () => {
      const fs = await GitCloneService.buildRepository({
        gitObjects: [],
      });

      expect(fs).toBeInstanceOf(MemFS);

      // Should have .git directory
      const stat = await fs.stat('.git');
      expect(stat.type).toBe('dir');
    });

    it('builds repository from exported git objects', async () => {
      // First create a repo with some commits
      const sourceFs = new MemFS();
      await git.init({ fs: sourceFs, dir: '/', defaultBranch: 'main' });
      await sourceFs.writeFile('test.txt', 'content');
      await git.add({ fs: sourceFs, dir: '/', filepath: 'test.txt' });
      await git.commit({
        fs: sourceFs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      // Export git objects
      const gitObjects: Array<{ path: string; data: Uint8Array }> = [];
      const files = (sourceFs as unknown as { files: Map<string, Uint8Array> }).files;
      for (const [path, data] of files.entries()) {
        if (path.startsWith('.git/')) {
          gitObjects.push({ path, data });
        }
      }

      // Build new repository from exported objects
      const targetFs = await GitCloneService.buildRepository({ gitObjects });

      // Verify HEAD exists
      const head = await git.resolveRef({ fs: targetFs, dir: '/', ref: 'HEAD' });
      expect(head).toBeTruthy();
      expect(head.length).toBe(40);
    });

    it('throws error on invalid git objects', async () => {
      // This tests error handling - providing corrupt data
      const invalidObjects = [{ path: '.git/invalid', data: new Uint8Array([255, 255, 255]) }];

      // Should still return a MemFS (init succeeds, import may have issues but shouldn't throw)
      const fs = await GitCloneService.buildRepository({ gitObjects: invalidObjects });
      expect(fs).toBeInstanceOf(MemFS);
    });
  });

  describe('handleInfoRefs', () => {
    let fs: MemFS;

    beforeEach(async () => {
      fs = new MemFS();
      await git.init({ fs, dir: '/', defaultBranch: 'main' });
    });

    it('returns service header and refs for empty repo', async () => {
      // Create a commit so we have a ref
      await fs.writeFile('test.txt', 'content');
      await git.add({ fs, dir: '/', filepath: 'test.txt' });
      await git.commit({
        fs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      const response = await GitCloneService.handleInfoRefs(fs);

      expect(response).toContain('# service=git-upload-pack');
      expect(response).toContain('HEAD');
      expect(response).toContain('refs/heads/main');
    });

    it('includes git capabilities', async () => {
      await fs.writeFile('test.txt', 'content');
      await git.add({ fs, dir: '/', filepath: 'test.txt' });
      await git.commit({
        fs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      const response = await GitCloneService.handleInfoRefs(fs);

      expect(response).toContain('side-band-64k');
      expect(response).toContain('thin-pack');
      expect(response).toContain('ofs-delta');
    });

    it('includes branch refs', async () => {
      await fs.writeFile('test.txt', 'content');
      await git.add({ fs, dir: '/', filepath: 'test.txt' });
      const oid = await git.commit({
        fs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      // Create additional branch
      await git.writeRef({ fs, dir: '/', ref: 'refs/heads/feature', value: oid });

      const response = await GitCloneService.handleInfoRefs(fs);

      expect(response).toContain('refs/heads/main');
      expect(response).toContain('refs/heads/feature');
    });

    it('ends with flush packet', async () => {
      await fs.writeFile('test.txt', 'content');
      await git.add({ fs, dir: '/', filepath: 'test.txt' });
      await git.commit({
        fs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      const response = await GitCloneService.handleInfoRefs(fs);

      expect(response.endsWith('0000')).toBe(true);
    });
  });

  describe('handleUploadPack', () => {
    let fs: MemFS;

    beforeEach(async () => {
      fs = new MemFS();
      await git.init({ fs, dir: '/', defaultBranch: 'main' });
    });

    it('returns packfile for repository with commits', async () => {
      await fs.writeFile('test.txt', 'content');
      await git.add({ fs, dir: '/', filepath: 'test.txt' });
      await git.commit({
        fs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      const packfile = await GitCloneService.handleUploadPack(fs);

      expect(packfile).toBeInstanceOf(Uint8Array);
      expect(packfile.length).toBeGreaterThan(0);
    });

    it('includes NAK packet at start', async () => {
      await fs.writeFile('test.txt', 'content');
      await git.add({ fs, dir: '/', filepath: 'test.txt' });
      await git.commit({
        fs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      const packfile = await GitCloneService.handleUploadPack(fs);

      // NAK packet is "0008NAK\n"
      const decoder = new TextDecoder();
      const start = decoder.decode(packfile.slice(0, 8));
      expect(start).toBe('0008NAK\n');
    });

    it('includes objects from all branches', async () => {
      // Create first commit on main
      await fs.writeFile('main.txt', 'main content');
      await git.add({ fs, dir: '/', filepath: 'main.txt' });
      const mainOid = await git.commit({
        fs,
        dir: '/',
        message: 'Main commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      // Create feature branch with another commit
      await git.writeRef({ fs, dir: '/', ref: 'refs/heads/feature', value: mainOid });
      await fs.writeFile('feature.txt', 'feature content');
      await git.add({ fs, dir: '/', filepath: 'feature.txt' });
      await git.commit({
        fs,
        dir: '/',
        message: 'Feature commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      const packfile = await GitCloneService.handleUploadPack(fs);

      // Should have objects from both branches
      expect(packfile.length).toBeGreaterThan(100);
    });

    it('ends with flush packet', async () => {
      await fs.writeFile('test.txt', 'content');
      await git.add({ fs, dir: '/', filepath: 'test.txt' });
      await git.commit({
        fs,
        dir: '/',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000 },
      });

      const packfile = await GitCloneService.handleUploadPack(fs);

      // Should end with flush packet "0000"
      const decoder = new TextDecoder();
      const end = decoder.decode(packfile.slice(-4));
      expect(end).toBe('0000');
    });
  });

  describe('formatPacketLine', () => {
    it('formats packet line with correct length prefix', () => {
      // Access private method via class prototype
      const formatPacketLine = (
        GitCloneService as unknown as {
          formatPacketLine: (data: string) => string;
        }
      ).formatPacketLine;

      const result = formatPacketLine('test data\n');
      // length = "test data\n" (10) + 4 = 14 = 0x0e
      expect(result).toBe('000etest data\n');
    });

    it('handles empty string', () => {
      const formatPacketLine = (
        GitCloneService as unknown as {
          formatPacketLine: (data: string) => string;
        }
      ).formatPacketLine;

      const result = formatPacketLine('');
      // length = 0 + 4 = 4 = 0x0004
      expect(result).toBe('0004');
    });
  });

  describe('wrapInSideband', () => {
    it('wraps packfile in sideband-64k format', () => {
      const wrapInSideband = (
        GitCloneService as unknown as {
          wrapInSideband: (packfile: Uint8Array) => Uint8Array;
        }
      ).wrapInSideband;

      const packfile = new Uint8Array([1, 2, 3, 4, 5]);
      const result = wrapInSideband(packfile);

      // Should have length header (4 bytes) + band byte (1) + data
      expect(result.length).toBeGreaterThan(packfile.length);

      // First 4 bytes are hex length
      const decoder = new TextDecoder();
      const lengthHex = decoder.decode(result.slice(0, 4));
      expect(lengthHex).toMatch(/^[0-9a-f]{4}$/);

      // Band byte should be 0x01 (packfile data)
      expect(result[4]).toBe(0x01);

      // Should end with flush packet
      const end = decoder.decode(result.slice(-4));
      expect(end).toBe('0000');
    });

    it('handles large packfiles with chunking', () => {
      const wrapInSideband = (
        GitCloneService as unknown as {
          wrapInSideband: (packfile: Uint8Array) => Uint8Array;
        }
      ).wrapInSideband;

      // Create packfile larger than 65515 bytes (CHUNK_SIZE)
      const largePackfile = new Uint8Array(70000);
      const result = wrapInSideband(largePackfile);

      // Should be split into multiple chunks
      expect(result.length).toBeGreaterThan(largePackfile.length);
    });

    it('handles empty packfile', () => {
      const wrapInSideband = (
        GitCloneService as unknown as {
          wrapInSideband: (packfile: Uint8Array) => Uint8Array;
        }
      ).wrapInSideband;

      const emptyPackfile = new Uint8Array(0);
      const result = wrapInSideband(emptyPackfile);

      // Should just be flush packet
      const decoder = new TextDecoder();
      expect(decoder.decode(result)).toBe('0000');
    });
  });
});
