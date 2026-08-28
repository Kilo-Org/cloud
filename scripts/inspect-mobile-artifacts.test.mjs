import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkResourceShrinking,
  INSPECT_JS_NEEDLES,
  bundleBufferContains,
  bundleBufferHasDebugId,
  inspectJsBundles,
} from './inspect-mobile-artifacts.mjs';

const SENTINEL_ENTRY = 'base/res/raw/kilo_shrink_sentinel_unused';
// Every needle plus the debug-id marker, joined into one ASCII fixture.
const BUNDLE_CONTENT = [...INSPECT_JS_NEEDLES, 'debugId'].join(' ');

// Minimal ZIP writer (local headers + central directory + EOCD) so the test is
// self-contained and only needs the system `unzip` that checkResourceShrinking
// already relies on to read entries back.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(outputPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const dataBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(dataBuffer);
    const entryCrc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(entryCrc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(entryCrc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, eocd]));
}

function withFixture(entries, run) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-shrink-test-'));
  const zipPath = join(work, 'fixture.aab');
  try {
    writeZip(zipPath, entries);
    return run(zipPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('checkResourceShrinking returns false when the sentinel is present', () => {
  const result = withFixture(
    [
      ['base/manifest/AndroidManifest.xml', '<manifest/>'],
      [SENTINEL_ENTRY, 'sentinel'],
    ],
    checkResourceShrinking
  );
  assert.equal(result, false);
});

test('checkResourceShrinking returns true when the sentinel is absent', () => {
  const result = withFixture(
    [['base/manifest/AndroidManifest.xml', '<manifest/>']],
    checkResourceShrinking
  );
  assert.equal(result, true);
});

test('bundleBufferContains matches UTF-8 and UTF-16LE bytes', () => {
  const utf16Buffer = Buffer.from(BUNDLE_CONTENT, 'utf16le');
  assert.equal(bundleBufferContains(Buffer.from(BUNDLE_CONTENT, 'utf8'), 'maskAllText'), true);
  assert.equal(bundleBufferContains(utf16Buffer, 'maskAllText'), true);
  assert.equal(bundleBufferContains(utf16Buffer, 'us.i.posthog.com'), true);
  assert.equal(bundleBufferContains(utf16Buffer, 'absent-marker'), false);
});

test('bundleBufferHasDebugId detects debugId and debug_id in either encoding', () => {
  assert.equal(bundleBufferHasDebugId(Buffer.from('debugId', 'utf8')), true);
  assert.equal(bundleBufferHasDebugId(Buffer.from('debug_id', 'utf8')), true);
  assert.equal(bundleBufferHasDebugId(Buffer.from('debugId', 'utf16le')), true);
  assert.equal(bundleBufferHasDebugId(Buffer.from('debug_id', 'utf16le')), true);
  assert.equal(bundleBufferHasDebugId(Buffer.from('no markers here', 'utf8')), false);
});

test('inspectJsBundles reports all needles and hasDebugId for a UTF-8 jsbundle', () => {
  const result = withFixture([['index.jsbundle', BUNDLE_CONTENT]], inspectJsBundles);
  assert.deepEqual(result.needlesFound.sort(), [...INSPECT_JS_NEEDLES].sort());
  assert.equal(result.hasDebugId, true);
});

test('inspectJsBundles reports all needles and hasDebugId for a UTF-16LE jsbundle', () => {
  const utf16Buffer = Buffer.from(BUNDLE_CONTENT, 'utf16le');
  const result = withFixture([['index.jsbundle', utf16Buffer]], inspectJsBundles);
  assert.deepEqual(result.needlesFound.sort(), [...INSPECT_JS_NEEDLES].sort());
  assert.equal(result.hasDebugId, true);
});

test('inspectJsBundles lacks maskAllText when the bundle omits it', () => {
  const content = [
    ...INSPECT_JS_NEEDLES.filter(needle => needle !== 'maskAllText'),
    'debugId',
  ].join(' ');
  const result = withFixture([['index.jsbundle', content]], inspectJsBundles);
  assert.equal(result.needlesFound.includes('maskAllText'), false);
});

test('inspectJsBundles reports hasDebugId false when debug-id markers are absent', () => {
  const result = withFixture([['index.jsbundle', INSPECT_JS_NEEDLES.join(' ')]], inspectJsBundles);
  assert.equal(result.hasDebugId, false);
});
