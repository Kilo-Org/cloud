import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
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
  });
});
