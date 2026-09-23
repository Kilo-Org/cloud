import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAppDependencies, readAabComponents } from './mobile-sbom-aab.mjs';

const METADATA_ENTRY = 'BUNDLE-METADATA/com.android.tools.build.libraries/dependencies.pb';
// 32 raw bytes 0x00..0x1f, so the expected hex digest is fixed and readable.
const DIGEST_BYTES = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const DIGEST_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

// Minimal protobuf writer for the fixed AppDependencies schema, so every
// fixture is synthesized in-test and no binary artifact is committed.
function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte += 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function tag(fieldNumber, wireType) {
  return varint(fieldNumber * 8 + wireType);
}

function bytesField(fieldNumber, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([tag(fieldNumber, 2), varint(data.length), data]);
}

function messageField(fieldNumber, parts) {
  return bytesField(fieldNumber, Buffer.concat(parts));
}

function varintField(fieldNumber, value) {
  return Buffer.concat([tag(fieldNumber, 0), varint(value)]);
}

function fixed64Field(fieldNumber) {
  return Buffer.concat([tag(fieldNumber, 1), Buffer.alloc(8, 0xff)]);
}

function fixed32Field(fieldNumber) {
  return Buffer.concat([tag(fieldNumber, 5), Buffer.alloc(4, 0xff)]);
}

function mavenLibraryMessage({ groupId, artifactId, version, packaging, classifier }) {
  const parts = [bytesField(1, groupId), bytesField(2, artifactId)];
  if (packaging !== undefined) {
    parts.push(bytesField(3, packaging));
  }
  if (classifier !== undefined) {
    parts.push(bytesField(4, classifier));
  }
  parts.push(bytesField(5, version));
  return Buffer.concat(parts);
}

function digestsMessage(digest) {
  return bytesField(1, digest);
}

// A top-level AppDependencies.library entry (field 1). An entry with no maven,
// digests, or unity payload serializes to a zero-length Library message.
function libraryField({ maven, digests, unity }) {
  const parts = [];
  if (maven) {
    parts.push(messageField(1, [maven]));
  }
  if (digests) {
    parts.push(messageField(2, [digestsMessage(digests)]));
  }
  if (unity) {
    parts.push(messageField(4, [unity]));
  }
  return messageField(1, parts);
}

// Minimal ZIP writer (local headers + central directory + EOCD) copied from
// scripts/inspect-mobile-artifacts.test.mjs so the test is self-contained and
// only needs the system `unzip` that readAabComponents already relies on.
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
  const work = mkdtempSync(join(tmpdir(), 'kilo-aab-test-'));
  const zipPath = join(work, 'fixture.aab');
  try {
    writeZip(zipPath, entries);
    return run(zipPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('parses Maven, Unity, dependency edges, and a SHA-256 digest', () => {
  const buffer = Buffer.concat([
    // Maven library with packaging, classifier, a digest, and unknown fields
    // of every skippable wire type (0 varint, 1 64-bit, 5 32-bit).
    libraryField({
      maven: Buffer.concat([
        mavenLibraryMessage({
          groupId: 'com.example',
          artifactId: 'alpha',
          version: '1.2.3',
          packaging: 'aar',
          classifier: 'release',
        }),
        varintField(10, 123),
        fixed64Field(11),
        fixed32Field(12),
        bytesField(13, 'unknown length-delimited field'),
      ]),
      digests: DIGEST_BYTES,
    }),
    // Maven library without packaging/classifier and without a digest.
    libraryField({
      maven: mavenLibraryMessage({
        groupId: 'org.example',
        artifactId: 'beta',
        version: '2.0.0',
      }),
    }),
    libraryField({
      unity: Buffer.concat([bytesField(1, 'com.unity.game'), bytesField(2, '9.9.9')]),
    }),
    messageField(2, [varintField(1, 0), varintField(2, 1)]),
    // Unknown top-level repository entry: skipped by wire type.
    bytesField(4, 'ignored repository entry'),
  ]);

  const parsed = parseAppDependencies(buffer);

  assert.equal(parsed.libraries.length, 2);
  assert.deepEqual(parsed.libraries[0], {
    groupId: 'com.example',
    artifactId: 'alpha',
    version: '1.2.3',
    packaging: 'aar',
    classifier: 'release',
    sha256: DIGEST_HEX,
  });
  assert.deepEqual(parsed.libraries[1], {
    groupId: 'org.example',
    artifactId: 'beta',
    version: '2.0.0',
    packaging: '',
    classifier: '',
    sha256: null,
  });
  assert.deepEqual(parsed.unityLibraries, [{ packageName: 'com.unity.game', version: '9.9.9' }]);
  assert.deepEqual(parsed.libraryDependencies, [{ libraryIndex: 0, dependencyIndices: [1] }]);
});

test('parses packed repeated dependency indices', () => {
  const buffer = Buffer.concat([
    libraryField({
      maven: mavenLibraryMessage({ groupId: 'g', artifactId: 'a', version: '1' }),
    }),
    messageField(2, [varintField(1, 3), bytesField(2, Buffer.concat([varint(4), varint(5)]))]),
  ]);

  const parsed = parseAppDependencies(buffer);

  assert.deepEqual(parsed.libraryDependencies, [{ libraryIndex: 3, dependencyIndices: [4, 5] }]);
  assert.equal(parsed.libraries[0].sha256, null);
});

test('rejects a truncated varint, an overlong length, and an unreadable Library', () => {
  // Field 1, wire type 2, then a length varint cut off at the buffer end.
  assert.throws(() => parseAppDependencies(Buffer.from([0x0a, 0x80])), /AppDependencies/);
  // Field 1, wire type 2, length 5, but only one payload byte present.
  assert.throws(() => parseAppDependencies(Buffer.from([0x0a, 0x05, 0x01])), /AppDependencies/);
  // Field 1, wire type 2, zero-length Library: neither oneof field is set.
  assert.throws(() => parseAppDependencies(Buffer.from([0x0a, 0x00])), /AppDependencies/);
  // No Library entry at all.
  assert.throws(() => parseAppDependencies(Buffer.alloc(0)), /AppDependencies/);
});

test('readAabComponents returns Maven and native-library components', () => {
  const metadata = Buffer.concat([
    libraryField({
      maven: mavenLibraryMessage({
        groupId: 'com.example',
        artifactId: 'alpha',
        version: '1.2.3',
      }),
      digests: DIGEST_BYTES,
    }),
  ]);

  withFixture(
    [
      [METADATA_ENTRY, metadata],
      ['base/lib/arm64-v8a/libfoo.so', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ],
    aabPath => {
      const { components, counts } = readAabComponents({ aabPath });

      assert.deepEqual(counts, { maven: 1, nativeLibraries: 1 });
      assert.equal(components.length, 2);
      assert.deepEqual(components[0], {
        ecosystem: 'maven',
        name: 'com.example:alpha',
        version: '1.2.3',
        purl: 'pkg:maven/com.example/alpha@1.2.3',
        hashes: [{ alg: 'SHA-256', content: DIGEST_HEX }],
        extraProperties: [],
      });
      assert.deepEqual(components[1], {
        ecosystem: 'native-library',
        name: 'libfoo.so',
        version: null,
        purl: 'pkg:generic/libfoo.so',
        extraProperties: [
          { name: 'kilo:sbom:abi', value: 'arm64-v8a' },
          { name: 'kilo:sbom:aab-path', value: 'base/lib/arm64-v8a/libfoo.so' },
        ],
      });
    }
  );
});

test('readAabComponents carries packaging and classifier as extra properties', () => {
  const metadata = Buffer.concat([
    libraryField({
      maven: mavenLibraryMessage({
        groupId: 'com.example',
        artifactId: 'alpha',
        version: '1.2.3',
        packaging: 'aar',
        classifier: 'sources',
      }),
    }),
  ]);

  withFixture([[METADATA_ENTRY, metadata]], aabPath => {
    const { components } = readAabComponents({ aabPath });

    assert.deepEqual(components[0].extraProperties, [
      { name: 'kilo:sbom:maven-packaging', value: 'aar' },
      { name: 'kilo:sbom:maven-classifier', value: 'sources' },
    ]);
  });
});

test('readAabComponents rejects an AAB without the dependency metadata', () => {
  withFixture([['base/manifest/AndroidManifest.xml', '<manifest/>']], aabPath => {
    assert.throws(() => readAabComponents({ aabPath }), /dependencies\.pb/);
  });
});
