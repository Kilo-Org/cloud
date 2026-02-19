import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { GitCloneService } from './git-clone-service';
import { GitReceivePackService } from './git-receive-pack-service';
import { MemFS } from './memfs';

// ---------------------------------------------------------------------------
// Helpers copied from git-receive-pack-service.test.ts
// ---------------------------------------------------------------------------

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

  chunks.push(encoder.encode('0000'));
  chunks.push(packfileBytes);

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const zeroOid = '0'.repeat(40);

function buildValidPackfile(blobContent: string): { packBytes: Uint8Array; blobOid: string } {
  const content = Buffer.from(blobContent);
  const gitObjectHeader = Buffer.from(`blob ${content.length}\0`);
  const blobOid = createHash('sha1')
    .update(Buffer.concat([gitObjectHeader, content]))
    .digest('hex');

  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);

  if (content.length > 15)
    throw new Error('buildValidPackfile: content too long for simple header');
  const objHeader = Buffer.from([(3 << 4) | content.length]);

  const deflated = deflateSync(content);
  const packBody = Buffer.concat([header, objHeader, deflated]);
  const checksum = createHash('sha1').update(packBody).digest();
  const packBytes = new Uint8Array(Buffer.concat([packBody, checksum]));

  return { packBytes, blobOid };
}

// ---------------------------------------------------------------------------
// Push helper: uses GitReceivePackService to populate a MemFS with real objects
// ---------------------------------------------------------------------------

async function pushToRepo(
  fs: MemFS,
  refs: Array<{ oldOid: string; newOid: string; refName: string }>,
  packBytes: Uint8Array
): Promise<void> {
  const requestData = buildPushRequest(refs, packBytes);
  const { result } = await GitReceivePackService.handleReceivePack(fs, requestData);
  if (!result.success) {
    throw new Error(`Push failed: ${result.errors.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers for smart HTTP info/refs responses
// ---------------------------------------------------------------------------

type ParsedInfoRefs = {
  service: string;
  headOid: string;
  capabilities: string;
  refs: Array<{ oid: string; refName: string }>;
};

/** Parse a git smart HTTP info/refs response into structured data. */
function parseInfoRefsResponse(response: string): ParsedInfoRefs {
  let offset = 0;

  // Read service announcement pkt-line
  const serviceHex = response.substring(offset, offset + 4);
  const serviceLen = parseInt(serviceHex, 16);
  const serviceLine = response.substring(offset + 4, offset + serviceLen);
  offset += serviceLen;

  // Skip flush packet
  if (response.substring(offset, offset + 4) === '0000') {
    offset += 4;
  }

  let headOid = '';
  let capabilities = '';
  const refs: Array<{ oid: string; refName: string }> = [];

  while (offset < response.length) {
    const hex = response.substring(offset, offset + 4);
    if (hex === '0000') break;

    const len = parseInt(hex, 16);
    const lineContent = response.substring(offset + 4, offset + len);
    offset += len;

    const trimmed = lineContent.replace(/\n$/, '');

    if (trimmed.includes('\0')) {
      // HEAD line with capabilities
      const [refPart, capsPart] = trimmed.split('\0');
      const spaceIdx = refPart.indexOf(' ');
      headOid = refPart.substring(0, spaceIdx);
      capabilities = capsPart;
    } else {
      const spaceIdx = trimmed.indexOf(' ');
      refs.push({
        oid: trimmed.substring(0, spaceIdx),
        refName: trimmed.substring(spaceIdx + 1),
      });
    }
  }

  return { service: serviceLine.trim(), headOid, capabilities, refs };
}

/**
 * Walk pkt-lines in a response string and verify that each hex-length prefix
 * correctly represents the UTF-8 byte length of the line (including the 4-byte
 * prefix itself). Skips flush packets (0000).
 */
function verifyPktLineLengths(response: string): void {
  const encoder = new TextEncoder();
  let offset = 0;

  while (offset < response.length) {
    const hex = response.substring(offset, offset + 4);
    if (hex === '0000') {
      offset += 4;
      continue;
    }

    const declaredLen = parseInt(hex, 16);
    if (isNaN(declaredLen) || declaredLen < 4) {
      throw new Error(`Invalid pkt-line hex at offset ${offset}: "${hex}"`);
    }

    // The content after the hex prefix up to declaredLen bytes total
    const lineContent = response.substring(offset + 4, offset + declaredLen);
    const byteLen = encoder.encode(lineContent).length + 4;

    expect(declaredLen).toBe(byteLen);

    offset += declaredLen;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitCloneService', () => {
  describe('handleInfoRefs', () => {
    it('advertises symref=HEAD:refs/heads/main when HEAD is symbolic', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('hello');

      await pushToRepo(
        fs,
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      const response = await GitCloneService.handleInfoRefs(fs);
      const parsed = parseInfoRefsResponse(response);

      expect(parsed.capabilities).toContain('symref=HEAD:refs/heads/main');
    });

    it('advertises symref=HEAD:refs/heads/main when HEAD is a raw OID matching main (legacy repo)', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('legacy');

      await pushToRepo(
        fs,
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      // Read the OID that refs/heads/main points to
      const mainOid = String(
        await fs.readFile('.git/refs/heads/main', { encoding: 'utf8' })
      ).trim();

      // Overwrite HEAD with the raw OID (simulating pre-PR#203 state)
      await fs.writeFile('.git/HEAD', mainOid);

      const response = await GitCloneService.handleInfoRefs(fs);
      const parsed = parseInfoRefsResponse(response);

      expect(parsed.capabilities).toContain('symref=HEAD:refs/heads/main');
    });

    it('does not advertise symref when HEAD is a raw OID matching no branch', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('orphan');

      await pushToRepo(
        fs,
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      // Overwrite HEAD with an OID that doesn't match any branch
      await fs.writeFile('.git/HEAD', 'b'.repeat(40));

      const response = await GitCloneService.handleInfoRefs(fs);
      const parsed = parseInfoRefsResponse(response);

      expect(parsed.capabilities).not.toContain('symref=');
    });

    it('advertises all branch refs', async () => {
      const fs = new MemFS();

      const { packBytes: pack1, blobOid: oid1 } = buildValidPackfile('one');
      await pushToRepo(fs, [{ oldOid: zeroOid, newOid: oid1, refName: 'refs/heads/main' }], pack1);

      const { packBytes: pack2, blobOid: oid2 } = buildValidPackfile('two');
      await pushToRepo(
        fs,
        [{ oldOid: zeroOid, newOid: oid2, refName: 'refs/heads/feature' }],
        pack2
      );

      const response = await GitCloneService.handleInfoRefs(fs);
      const parsed = parseInfoRefsResponse(response);

      const refNames = parsed.refs.map(r => r.refName);
      expect(refNames).toContain('refs/heads/main');
      expect(refNames).toContain('refs/heads/feature');
    });

    it('HEAD line OID matches refs/heads/main OID', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('match');

      await pushToRepo(
        fs,
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      const response = await GitCloneService.handleInfoRefs(fs);
      const parsed = parseInfoRefsResponse(response);

      // Read the OID from refs/heads/main
      const mainOid = String(
        await fs.readFile('.git/refs/heads/main', { encoding: 'utf8' })
      ).trim();

      expect(parsed.headOid).toBe(mainOid);
    });
  });

  describe('formatPacketLine', () => {
    it('pkt-line hex lengths match UTF-8 byte lengths', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('pkt');

      await pushToRepo(
        fs,
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      const response = await GitCloneService.handleInfoRefs(fs);

      // Verify every pkt-line in the response has correct hex lengths
      verifyPktLineLengths(response);
    });
  });

  describe('handleUploadPack', () => {
    it('returns data starting with NAK', async () => {
      const fs = new MemFS();
      const { packBytes, blobOid } = buildValidPackfile('nak');

      await pushToRepo(
        fs,
        [{ oldOid: zeroOid, newOid: blobOid, refName: 'refs/heads/main' }],
        packBytes
      );

      const result = await GitCloneService.handleUploadPack(fs);

      // First 8 bytes should be "0008NAK\n"
      const first8 = new TextDecoder().decode(result.slice(0, 8));
      expect(first8).toBe('0008NAK\n');
    });
  });
});
