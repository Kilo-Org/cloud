import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { registerFileRoutes } from './files';

vi.mock('node:fs', () => ({
  default: {
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    copyFileSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p), // identity by default (no symlinks)
  },
}));

vi.mock('../atomic-write', () => ({
  atomicWrite: vi.fn(),
}));

vi.mock('../backup-file', () => ({
  backupFile: vi.fn(),
}));

import fs from 'node:fs';
import { atomicWrite } from '../atomic-write';
import { backupFile } from '../backup-file';

const TOKEN = 'test-token';
const ROOT = '/root/.openclaw';

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

function mockDirent(name: string, isDir: boolean, isSymlink = false) {
  return {
    name,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    isFile: () => !isDir && !isSymlink,
  };
}

describe('file routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    registerFileRoutes(app, TOKEN, ROOT);
  });

  describe('auth', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await app.request('/_kilo/files/tree');
      expect(res.status).toBe(401);
    });

    it('rejects wrong token', async () => {
      const res = await app.request('/_kilo/files/tree', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('protects the bot identity route', async () => {
      const res = await app.request('/_kilo/bot-identity', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ botName: 'Milo' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /_kilo/bot-identity', () => {
    it('writes workspace/IDENTITY.md', async () => {
      vi.mocked(fs.existsSync).mockImplementation(
        (path: any) => typeof path === 'string' && path.endsWith('BOOTSTRAP.md')
      );

      const res = await app.request('/_kilo/bot-identity', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ botName: 'Milo', botNature: 'Operator' }),
      });

      expect(res.status).toBe(200);
      expect(atomicWrite).toHaveBeenCalledWith(
        `${ROOT}/workspace/IDENTITY.md`,
        expect.stringContaining('- Name: Milo')
      );

      const body = (await res.json()) as any;
      expect(body.path).toBe('workspace/IDENTITY.md');
      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(`${ROOT}/workspace/BOOTSTRAP.md`);
    });
  });

  describe('POST /_kilo/user-profile', () => {
    it('writes workspace/USER.md with location', async () => {
      vi.mocked(fs.existsSync).mockImplementation(
        (path: any) => typeof path === 'string' && path !== `${ROOT}/workspace/USER.md`
      );

      const res = await app.request('/_kilo/user-profile', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ userLocation: 'Amsterdam, North Holland, Netherlands' }),
      });

      expect(res.status).toBe(200);
      expect(atomicWrite).toHaveBeenCalledWith(
        `${ROOT}/workspace/USER.md`,
        expect.stringContaining('- Location: Amsterdam, North Holland, Netherlands')
      );

      const body = (await res.json()) as any;
      expect(body.path).toBe('workspace/USER.md');
      expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalled();
    });

    it('clears an existing workspace/USER.md location when location is null', async () => {
      vi.mocked(fs.existsSync).mockImplementation(
        (path: any) => typeof path === 'string' && path === `${ROOT}/workspace/USER.md`
      );
      vi.mocked(fs.readFileSync).mockReturnValue(
        '# USER\n- Timezone: Europe/Amsterdam\n- Location: Amsterdam\n- Notes:\n'
      );

      const res = await app.request('/_kilo/user-profile', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ userLocation: null }),
      });

      expect(res.status).toBe(200);
      expect(atomicWrite).toHaveBeenCalledWith(
        `${ROOT}/workspace/USER.md`,
        '# USER\n- Timezone: Europe/Amsterdam\n- Notes:\n'
      );
      expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
    });
  });

  describe('GET /_kilo/files/tree', () => {
    it('returns recursive directory listing including credentials', async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
        if (dir === ROOT) {
          return [
            mockDirent('openclaw.json', false),
            mockDirent('workspace', true),
            mockDirent('credentials', true),
            mockDirent('SOUL.md.bak.2026-03-01', false),
            mockDirent('debug.log', false),
          ] as any;
        }
        if (dir === `${ROOT}/workspace`) {
          return [mockDirent('SOUL.md', false)] as any;
        }
        if (dir === `${ROOT}/credentials`) {
          return [mockDirent('token.txt', false)] as any;
        }
        return [];
      });

      const res = await app.request('/_kilo/files/tree', { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      const names = body.tree.flatMap(function flatNames(n: any): string[] {
        return [n.name, ...(n.children ? n.children.flatMap(flatNames) : [])];
      });
      expect(names).toContain('openclaw.json');
      expect(names).toContain('SOUL.md.bak.2026-03-01');
      expect(names).toContain('debug.log');
      expect(names).toContain('SOUL.md');
      expect(names).toContain('credentials');
      expect(names).toContain('token.txt');
    });

    it('skips symlinks', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        mockDirent('real.md', false),
        mockDirent('linked.md', false, true),
      ] as any);

      const res = await app.request('/_kilo/files/tree', { headers: authHeaders() });
      const body = (await res.json()) as any;
      expect(body.tree).toHaveLength(1);
      expect(body.tree[0].name).toBe('real.md');
    });
  });

  describe('GET /_kilo/files/read', () => {
    it('reads a file and returns content with etag', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('# My Agent');

      const res = await app.request('/_kilo/files/read?path=workspace/SOUL.md', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.content).toBe('# My Agent');
      expect(body.etag).toBeDefined();
    });

    it('reads files with any extension', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('log content');

      const res = await app.request('/_kilo/files/read?path=debug.log', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.content).toBe('log content');
    });

    it('rejects path traversal', async () => {
      const res = await app.request('/_kilo/files/read?path=../etc/passwd', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for missing file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const res = await app.request('/_kilo/files/read?path=workspace/SOUL.md', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it('rejects symlinks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);

      const res = await app.request('/_kilo/files/read?path=workspace/linked.md', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /_kilo/files/write', () => {
    it('writes a file with backup', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('old content');

      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          path: 'workspace/SOUL.md',
          content: 'new content',
        }),
      });
      expect(res.status).toBe(200);
      expect(backupFile).toHaveBeenCalledWith(`${ROOT}/workspace/SOUL.md`, ROOT);
      expect(atomicWrite).toHaveBeenCalledWith(`${ROOT}/workspace/SOUL.md`, 'new content');

      const body = (await res.json()) as any;
      expect(body.etag).toBeDefined();
    });

    it('returns 404 for non-existent file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          path: 'workspace/NEW.md',
          content: 'content',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 on etag mismatch', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('current content');

      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          path: 'workspace/SOUL.md',
          content: 'new content',
          etag: 'wrong-etag',
        }),
      });
      expect(res.status).toBe(409);

      const body = (await res.json()) as any;
      expect(body.code).toBe('file_etag_conflict');
    });

    it('writes files with any extension', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);

      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: 'debug.log', content: 'new log content' }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.etag).toBeDefined();
    });

    it('path traversal still rejected', async () => {
      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: '../etc/passwd', content: 'hacked' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid body shape', async () => {
      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: {}, content: 123 }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing content', async () => {
      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: 'SOUL.md' }),
      });
      expect(res.status).toBe(400);
    });
  });
});
