import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import git from '@ashishkumar472/cf-git';
import { GitReceivePackService } from './git-receive-pack-service';
import { MemFS } from './memfs';
import { MAX_OBJECT_SIZE } from './constants';

// Helper to build a git pkt-line push request with a packfile payload
function buildPushRequest(
  refs: Array<{ oldOid: string; newOid: string; refName: string }>,
  packfileBytes: Uint8Array
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < refs.length; i++) {
    const { oldOid, newOid, refName } = refs[i];
    let line = `${oldOid} ${newOid} ${refName}`;
    if (i === 0) {
      line += '\0 report-status';
    }
    line += '\n';
    const lengthHex = (line.length + 4).toString(16).padStart(4, '0');
    chunks.push(encoder.encode(lengthHex + line));
  }

  // Flush packet
  chunks.push(encoder.encode('0000'));

  // Append packfile bytes
  chunks.push(packfileBytes);

  // Concatenate
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const fakeNewOid = 'a'.repeat(40);
const zeroOid = '0'.repeat(40);

// A truncated packfile: valid PACK magic so the header scanner finds it,
// but too short for cf-git's indexPack to parse — causes a real error.
function buildCorruptPackfile(): Uint8Array {
  return new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // just "PACK", no version/count
}

// Build a valid packfile containing a single blob object.
// cf-git's indexPack will succeed on this and return the blob's OID.
// The OID is SHA1("blob <size>\0<content>").
function buildValidPackfile(blobContent: string): { packBytes: Uint8Array; blobOid: string } {
  const content = Buffer.from(blobContent);

  // Compute the git object OID: SHA1("blob <len>\0<content>")
  const gitObjectHeader = Buffer.from(`blob ${content.length}\0`);
  const blobOid = createHash('sha1')
    .update(Buffer.concat([gitObjectHeader, content]))
    .digest('hex');

  // PACK header: magic + version 2 + 1 object
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);

  // Object header byte: type=3 (blob) in bits 6-4, size in bits 3-0.
  // For content <= 15 bytes, no continuation bit needed.
  if (content.length > 15)
    throw new Error('buildValidPackfile: content too long for simple header');
  const objHeader = Buffer.from([(3 << 4) | content.length]);

  // Zlib-deflate the content
  const deflated = deflateSync(content);

  // Assemble pack body (everything before the checksum)
  const packBody = Buffer.concat([header, objHeader, deflated]);

  // 20-byte SHA-1 checksum of the body
  const checksum = createHash('sha1').update(packBody).digest();
  const packBytes = new Uint8Array(Buffer.concat([packBody, checksum]));

  return { packBytes, blobOid };
}

describe('GitReceivePackService', () => {
  describe('parsePktLines', () => {
    it('parses a single ref update command', () => {
      const oldOid = 'a'.repeat(40);
      const newOid = 'b'.repeat(40);
      const line = `${oldOid} ${newOid} refs/heads/main\0 report-status\n`;
      const lengthHex = (line.length + 4).toString(16).padStart(4, '0');
      const pktLine = lengthHex + line + '0000';
      const data = new TextEncoder().encode(pktLine);

      const { commands, packfileStart } = GitReceivePackService.parsePktLines(data);

      expect(commands).toHaveLength(1);
      expect(commands[0]).toEqual({
        oldOid,
        newOid,
        refName: 'refs/heads/main',
      });
      expect(packfileStart).toBe(pktLine.length);
    });

    it('parses multiple ref update commands', () => {
      const encoder = new TextEncoder();
      const chunks: string[] = [];

      const line1 = `${'a'.repeat(40)} ${'b'.repeat(40)} refs/heads/main\0 report-status\n`;
      chunks.push((line1.length + 4).toString(16).padStart(4, '0') + line1);

      const line2 = `${'c'.repeat(40)} ${'d'.repeat(40)} refs/heads/feature\n`;
      chunks.push((line2.length + 4).toString(16).padStart(4, '0') + line2);

      chunks.push('0000');

      const data = encoder.encode(chunks.join(''));
      const { commands } = GitReceivePackService.parsePktLines(data);

      expect(commands).toHaveLength(2);
      expect(commands[0].refName).toBe('refs/heads/main');
      expect(commands[1].refName).toBe('refs/heads/feature');
    });

    it('returns empty commands for flush-only data', () => {
      const data = new TextEncoder().encode('0000');
      const { commands, packfileStart } = GitReceivePackService.parsePktLines(data);

      expect(commands).toHaveLength(0);
      expect(packfileStart).toBe(4);
    });

    it('ignores malformed lines (too few parts)', () => {
      const line = `${'a'.repeat(40)} refs/heads/main\n`;
      const lengthHex = (line.length + 4).toString(16).padStart(4, '0');
      const pktLine = lengthHex + line + '0000';
      const data = new TextEncoder().encode(pktLine);

      const { commands } = GitReceivePackService.parsePktLines(data);
      expect(commands).toHaveLength(0);
    });

    it('sets packfileStart after flush packet', () => {
      const line = `${'a'.repeat(40)} ${'b'.repeat(40)} refs/heads/main\n`;
      const lengthHex = (line.length + 4).toString(16).padStart(4, '0');
      const pktPart = lengthHex + line;
      const flush = '0000';
      const packData = 'PACKsomedata';
      const full = pktPart + flush + packData;
      const data = new TextEncoder().encode(full);

      const { packfileStart } = GitReceivePackService.parsePktLines(data);
      expect(packfileStart).toBe(pktPart.length + flush.length);
    });
  });

  describe('handleReceivePack', () => {
    it('rejects packfiles exceeding MAX_OBJECT_SIZE', async () => {
      const fs = new MemFS();
      const oversizedPack = new Uint8Array(MAX_OBJECT_SIZE + 1);
      oversizedPack[0] = 0x50;
      oversizedPack[1] = 0x41;
      oversizedPack[2] = 0x43;
      oversizedPack[3] = 0x4b;

      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' }],
        oversizedPack
      );

      const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Packfile too large');
    });

    it('does not update refs when packfile size validation fails', async () => {
      const fs = new MemFS();
      const oversizedPack = new Uint8Array(MAX_OBJECT_SIZE + 1);
      oversizedPack[0] = 0x50;
      oversizedPack[1] = 0x41;
      oversizedPack[2] = 0x43;
      oversizedPack[3] = 0x4b;

      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' }],
        oversizedPack
      );

      await GitReceivePackService.handleReceivePack(fs, requestData);

      await expect(fs.readFile('.git/refs/heads/main')).rejects.toThrow('ENOENT');
    });

    it('returns early with error on indexPack failure', async () => {
      const fs = new MemFS();
      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' }],
        buildCorruptPackfile()
      );

      const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Failed to index packfile');
    });

    it('does not update refs when indexPack fails', async () => {
      const fs = new MemFS();
      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' }],
        buildCorruptPackfile()
      );

      await GitReceivePackService.handleReceivePack(fs, requestData);

      await expect(fs.readFile('.git/refs/heads/main')).rejects.toThrow('ENOENT');
    });

    it('cleans up .pack file from filesystem on indexPack failure', async () => {
      const fs = new MemFS();
      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' }],
        buildCorruptPackfile()
      );

      await GitReceivePackService.handleReceivePack(fs, requestData);

      const packDir = await fs.readdir('.git/objects/pack').catch(() => []);
      const packFiles = packDir.filter((f: string) => f.endsWith('.pack'));
      expect(packFiles).toHaveLength(0);
    });

    it('rejects ref update when newOid is not in the indexed pack', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid: _blobOid } = buildValidPackfile('hello');

      // Push with a ref pointing to an OID that does NOT exist in the pack
      const bogusOid = 'dead'.repeat(10);
      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: bogusOid, refName: 'refs/heads/main' }],
        packBytes
      );

      const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('does not write ref file when newOid is not in the indexed pack', async () => {
      const fs = new MemFS();
      const { packBytes } = buildValidPackfile('hello');

      const bogusOid = 'dead'.repeat(10);
      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: bogusOid, refName: 'refs/heads/main' }],
        packBytes
      );

      await GitReceivePackService.handleReceivePack(fs, requestData);

      // The ref should NOT exist — writing it would corrupt the repo
      await expect(fs.readFile('.git/refs/heads/main')).rejects.toThrow('ENOENT');
    });

    it('allows ref update when newOid IS in the indexed pack', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('hello');

      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects only the refs with missing OIDs, not the entire push', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('hello');

      const bogusOid = 'dead'.repeat(10);
      const requestData = buildPushRequest(
        [
          { oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/good' },
          { oldOid: zeroOid, newOid: bogusOid, refName: 'refs/heads/bad' },
        ],
        packBytes
      );

      const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);

      // The good ref should have been written
      const goodRef = await fs.readFile('.git/refs/heads/good', { encoding: 'utf8' });
      expect(String(goodRef)).toContain(blobOid);

      // The bad ref should NOT exist
      await expect(fs.readFile('.git/refs/heads/bad')).rejects.toThrow('ENOENT');

      // Should report an error for the bad ref
      expect(result.errors.some(e => e.includes('refs/heads/bad'))).toBe(true);
    });

    it('allows ref update pointing to object from a previous push', async () => {
      const fs = new MemFS();

      // First push: index a valid packfile so its blob OID exists in the repo
      const { packBytes: firstPack, blobOid: existingOid } = buildValidPackfile('first');
      const firstRequest = buildPushRequest(
        [{ oldOid: zeroOid, newOid: existingOid, refName: 'refs/heads/main' }],
        firstPack
      );
      const { result: firstResult } = await GitReceivePackService.handleReceivePack(
        fs,
        firstRequest
      );
      expect(firstResult.success).toBe(true);

      // Second push: a NEW packfile with a different blob, but one ref targets the old OID
      const { packBytes: secondPack, blobOid: newOid } = buildValidPackfile('second');
      const secondRequest = buildPushRequest(
        [
          { oldOid: zeroOid, newOid: newOid, refName: 'refs/heads/feature' },
          { oldOid: zeroOid, newOid: existingOid, refName: 'refs/heads/also-main' },
        ],
        secondPack
      );
      const { result: secondResult } = await GitReceivePackService.handleReceivePack(
        fs,
        secondRequest
      );

      // Both refs should succeed — existingOid is in the repo from the first push
      expect(secondResult.errors).toHaveLength(0);
      expect(secondResult.success).toBe(true);

      const alsoMainRef = await fs.readFile('.git/refs/heads/also-main', { encoding: 'utf8' });
      expect(String(alsoMainRef)).toContain(existingOid);
    });

    it('still rejects ref pointing to truly nonexistent object across pushes', async () => {
      const fs = new MemFS();

      // First push: seed the repo with one valid object
      const { packBytes, blobOid } = buildValidPackfile('seed');
      const firstRequest = buildPushRequest(
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );
      await GitReceivePackService.handleReceivePack(fs, firstRequest);

      // Second push: ref targets an OID that has never existed anywhere
      const { packBytes: secondPack } = buildValidPackfile('other');
      const bogusOid = 'dead'.repeat(10);
      const secondRequest = buildPushRequest(
        [{ oldOid: zeroOid, newOid: bogusOid, refName: 'refs/heads/bad' }],
        secondPack
      );
      const { result } = await GitReceivePackService.handleReceivePack(fs, secondRequest);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('refs/heads/bad'))).toBe(true);
      await expect(fs.readFile('.git/refs/heads/bad')).rejects.toThrow('ENOENT');
    });

    it('handles push with no packfile data (delete-only)', async () => {
      const fs = new MemFS();
      await fs.writeFile('.git/refs/heads/feature', fakeNewOid);

      const requestData = buildPushRequest(
        [{ oldOid: fakeNewOid, newOid: zeroOid, refName: 'refs/heads/feature' }],
        new Uint8Array(0)
      );

      const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);

      expect(result.errors.filter(e => e.includes('packfile'))).toHaveLength(0);
    });

    it('reports ng for all refs when packfile exceeds size limit', async () => {
      const fs = new MemFS();
      const oversizedPack = new Uint8Array(MAX_OBJECT_SIZE + 1);
      oversizedPack[0] = 0x50;
      oversizedPack[1] = 0x41;
      oversizedPack[2] = 0x43;
      oversizedPack[3] = 0x4b;

      const requestData = buildPushRequest(
        [
          { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' },
          { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/feature' },
        ],
        oversizedPack
      );

      const { response } = await GitReceivePackService.handleReceivePack(fs, requestData);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('error');
      expect(status.refs).toEqual([
        {
          status: 'ng',
          refName: 'refs/heads/main',
          message: expect.stringContaining('Packfile too large'),
        },
        {
          status: 'ng',
          refName: 'refs/heads/feature',
          message: expect.stringContaining('Packfile too large'),
        },
      ]);
    });

    it('reports ng for all refs when indexPack fails', async () => {
      const fs = new MemFS();
      const requestData = buildPushRequest(
        [
          { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' },
          { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/feature' },
        ],
        buildCorruptPackfile()
      );

      const { response } = await GitReceivePackService.handleReceivePack(fs, requestData);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('error');
      expect(status.refs).toEqual([
        {
          status: 'ng',
          refName: 'refs/heads/main',
          message: expect.stringContaining('Failed to index packfile'),
        },
        {
          status: 'ng',
          refName: 'refs/heads/feature',
          message: expect.stringContaining('Failed to index packfile'),
        },
      ]);
    });
  });

  describe('HEAD symbolic ref', () => {
    it('creates a symbolic HEAD on first push to main', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('hello');

      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);
      expect(result.success).toBe(true);

      // HEAD should be a symbolic ref, not a detached OID
      const headContent = String(await fs.readFile('.git/HEAD', { encoding: 'utf8' })).trim();
      expect(headContent).toBe('ref: refs/heads/main');

      // resolveRef should follow the symref to the branch OID
      const resolved = await git.resolveRef({ fs, dir: '/', ref: 'HEAD' });
      expect(resolved).toBe(blobOid);
    });

    it('does not overwrite HEAD on subsequent pushes to main', async () => {
      const fs = new MemFS();
      const { packBytes: firstPack, blobOid: firstOid } = buildValidPackfile('first');

      // First push — sets HEAD
      const firstRequest = buildPushRequest(
        [{ oldOid: zeroOid, newOid: firstOid, refName: 'refs/heads/main' }],
        firstPack
      );
      await GitReceivePackService.handleReceivePack(fs, firstRequest);

      const headAfterFirst = String(await fs.readFile('.git/HEAD', { encoding: 'utf8' })).trim();
      expect(headAfterFirst).toBe('ref: refs/heads/main');

      // Second push — HEAD should remain symbolic, not be rewritten
      const { packBytes: secondPack, blobOid: secondOid } = buildValidPackfile('second');
      const secondRequest = buildPushRequest(
        [{ oldOid: firstOid, newOid: secondOid, refName: 'refs/heads/main' }],
        secondPack
      );
      await GitReceivePackService.handleReceivePack(fs, secondRequest);

      const headAfterSecond = String(await fs.readFile('.git/HEAD', { encoding: 'utf8' })).trim();
      expect(headAfterSecond).toBe('ref: refs/heads/main');

      // HEAD should resolve to the new OID via the symref
      const resolved = await git.resolveRef({ fs, dir: '/', ref: 'HEAD' });
      expect(resolved).toBe(secondOid);
    });

    it('creates symbolic HEAD for master branch too', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('hello');

      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/master' }],
        packBytes
      );

      await GitReceivePackService.handleReceivePack(fs, requestData);

      const headContent = String(await fs.readFile('.git/HEAD', { encoding: 'utf8' })).trim();
      expect(headContent).toBe('ref: refs/heads/master');
    });

    it('does not set HEAD when pushing a non-default branch', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('hello');

      const requestData = buildPushRequest(
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/feature' }],
        packBytes
      );

      await GitReceivePackService.handleReceivePack(fs, requestData);

      // HEAD should not exist — no main/master was pushed
      await expect(fs.readFile('.git/HEAD')).rejects.toThrow('ENOENT');
    });
  });

  describe('generateReportStatus', () => {
    it('reports unpack ok and ok for all refs when no errors', () => {
      const commands = [
        { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' },
        { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/feature' },
      ];

      const response = GitReceivePackService.generateReportStatus(commands, []);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('ok');
      expect(status.refs).toEqual([
        { status: 'ok', refName: 'refs/heads/main' },
        { status: 'ok', refName: 'refs/heads/feature' },
      ]);
    });

    it('marks all refs ng when a global error exists', () => {
      const commands = [
        { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' },
        { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/feature' },
      ];
      const errors = [{ kind: 'global' as const, message: 'Packfile too large' }];

      const response = GitReceivePackService.generateReportStatus(commands, errors);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('error');
      expect(status.refs).toEqual([
        { status: 'ng', refName: 'refs/heads/main', message: 'Packfile too large' },
        { status: 'ng', refName: 'refs/heads/feature', message: 'Packfile too large' },
      ]);
    });

    it('marks only the matched ref ng for a per-ref error', () => {
      const commands = [
        { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' },
        { oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/feature' },
      ];
      const errors = [
        { kind: 'ref' as const, refName: 'refs/heads/feature', message: 'object missing' },
      ];

      const response = GitReceivePackService.generateReportStatus(commands, errors);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('ok');
      expect(status.refs).toEqual([
        { status: 'ok', refName: 'refs/heads/main' },
        { status: 'ng', refName: 'refs/heads/feature', message: 'object missing' },
      ]);
    });

    it('global error takes precedence over per-ref status', () => {
      const commands = [{ oldOid: zeroOid, newOid: fakeNewOid, refName: 'refs/heads/main' }];
      const errors = [
        { kind: 'global' as const, message: 'index failed' },
        { kind: 'ref' as const, refName: 'refs/heads/main', message: 'specific error' },
      ];

      const response = GitReceivePackService.generateReportStatus(commands, errors);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('error');
      // Global error should apply to all refs
      expect(status.refs).toEqual([
        { status: 'ng', refName: 'refs/heads/main', message: 'index failed' },
      ]);
    });

    it('returns unpack ok with no ref lines when commands array is empty', () => {
      const response = GitReceivePackService.generateReportStatus([], []);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('ok');
      expect(status.refs).toEqual([]);
    });

    it('handles global error with empty commands (catch-all path)', () => {
      const errors = [{ kind: 'global' as const, message: 'Unknown error' }];

      const response = GitReceivePackService.generateReportStatus([], errors);
      const status = parseReportStatus(response);

      expect(status.unpack).toBe('error');
      expect(status.refs).toEqual([]);
    });
  });
});

// Parse the sideband-wrapped report-status binary response into structured data.
// Format: each sideband-1 packet contains a pkt-line; lines are "unpack ok/error"
// followed by "ok <ref>" or "ng <ref> <message>" lines, ending with a flush.
type RefStatus =
  | { status: 'ok'; refName: string }
  | { status: 'ng'; refName: string; message: string };

function parseReportStatus(data: Uint8Array): { unpack: string; refs: RefStatus[] } {
  const decoder = new TextDecoder();
  let offset = 0;
  const lines: string[] = [];

  // Read sideband packets until we hit the final flush (0000)
  while (offset < data.length) {
    const hexLen = decoder.decode(data.subarray(offset, offset + 4));
    if (hexLen === '0000') {
      offset += 4;
      // Could be the inner flush (inside sideband) or the outer flush.
      // If we've already collected lines and the next 4 bytes are also 0000, that's the outer flush.
      continue;
    }
    const pktLen = parseInt(hexLen, 16);
    if (pktLen === 0 || isNaN(pktLen)) break;

    // byte at offset+4 is the sideband band number
    const band = data[offset + 4];
    const payload = data.subarray(offset + 5, offset + pktLen);

    if (band === 1) {
      // The payload is itself a pkt-line (or flush)
      const payloadStr = decoder.decode(payload);
      // Could be a pkt-line "XXXX<content>" or "0000" (inner flush)
      if (payloadStr === '0000') {
        offset += pktLen;
        continue;
      }
      const innerHex = payloadStr.substring(0, 4);
      const innerLen = parseInt(innerHex, 16);
      if (innerLen > 4) {
        const line = payloadStr.substring(4, innerLen).replace(/\n$/, '');
        lines.push(line);
      }
    }
    offset += pktLen;
  }

  // First line should be "unpack ok" or "unpack error"
  let unpack = 'unknown';
  const refs: RefStatus[] = [];

  for (const line of lines) {
    if (line.startsWith('unpack ')) {
      unpack = line.substring('unpack '.length);
    } else if (line.startsWith('ok ')) {
      refs.push({ status: 'ok', refName: line.substring('ok '.length) });
    } else if (line.startsWith('ng ')) {
      const rest = line.substring('ng '.length);
      const spaceIdx = rest.indexOf(' ');
      refs.push({
        status: 'ng',
        refName: rest.substring(0, spaceIdx),
        message: rest.substring(spaceIdx + 1),
      });
    }
  }

  return { unpack, refs };
}
