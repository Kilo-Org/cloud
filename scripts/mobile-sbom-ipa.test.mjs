import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { comparePodfileLock, parseMachODylibs, readIpaComponents } from './mobile-sbom-ipa.mjs';

const LC_LOAD_DYLIB = 0x0c;
const LC_ID_DYLIB = 0x0d;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Kilo</string>
  <key>CFBundleIdentifier</key>
  <string>com.kilocode.kiloapp</string>
</dict>
</plist>
`;

// Minimal ZIP writer (local headers + central directory + EOCD) copied from
// scripts/inspect-mobile-artifacts.test.mjs so the test is self-contained and
// only needs the system `unzip` that inspect-mobile-artifacts already relies on.
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

function withZip(entries, run) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-sbom-ipa-test-'));
  const zipPath = join(work, 'fixture.ipa');
  try {
    writeZip(zipPath, entries);
    return run(zipPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeU32(buffer, offset, value, littleEndian) {
  if (littleEndian) {
    buffer.writeUInt32LE(value, offset);
  } else {
    buffer.writeUInt32BE(value, offset);
  }
}

// dylib_command: cmd, cmdsize, lc_str name offset (24), timestamp, versions.
function dylibCommand(cmd, name, littleEndian) {
  const nameBytes = Buffer.from(`${name}\0`, 'utf8');
  const cmdsize = Math.ceil((24 + nameBytes.length) / 8) * 8;
  const command = Buffer.alloc(cmdsize);
  writeU32(command, 0, cmd, littleEndian);
  writeU32(command, 4, cmdsize, littleEndian);
  writeU32(command, 8, 24, littleEndian);
  nameBytes.copy(command, 24);
  return command;
}

function magicAsReadBigEndian({ is64, littleEndian }) {
  if (littleEndian) {
    return is64 ? 0xcffaedfe : 0xcefaedfe;
  }
  return is64 ? 0xfeedfacf : 0xfeedface;
}

function buildThin({ is64, littleEndian, commands }) {
  const headerSize = is64 ? 32 : 28;
  const commandsBuffer = Buffer.concat(commands);
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(magicAsReadBigEndian({ is64, littleEndian }), 0);
  writeU32(header, 16, commands.length, littleEndian);
  writeU32(header, 20, commandsBuffer.length, littleEndian);
  return Buffer.concat([header, commandsBuffer]);
}

function buildFat({ bigEndian, slices }) {
  const littleEndian = !bigEndian;
  const headerSize = 8 + 20 * slices.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(bigEndian ? 0xcafebabe : 0xbebafeca, 0);
  writeU32(header, 4, slices.length, littleEndian);
  let offset = headerSize;
  slices.forEach((slice, index) => {
    const entry = 8 + 20 * index;
    writeU32(header, entry + 8, offset, littleEndian);
    writeU32(header, entry + 12, slice.length, littleEndian);
    offset += slice.length;
  });
  return Buffer.concat([header, ...slices]);
}

const TWO_DYLIBS = ['/usr/lib/libAlpha.dylib', '@rpath/libBeta.dylib'];

function buildFixtureImage({ is64 = true, littleEndian = true } = {}) {
  return buildThin({
    is64,
    littleEndian,
    commands: [
      dylibCommand(LC_LOAD_DYLIB, TWO_DYLIBS[0], littleEndian),
      dylibCommand(LC_ID_DYLIB, '@rpath/Kilo', littleEndian),
      dylibCommand(LC_LOAD_DYLIB, TWO_DYLIBS[1], littleEndian),
    ],
  });
}

test('parseMachODylibs reads LC_LOAD_DYLIB and skips LC_ID_DYLIB on a thin 64-bit LE image', () => {
  const image = buildFixtureImage();
  assert.deepEqual(parseMachODylibs(image), TWO_DYLIBS);
});

test('parseMachODylibs reads 32-bit and big-endian thin images', () => {
  for (const variant of [
    { is64: false, littleEndian: true },
    { is64: false, littleEndian: false },
    { is64: true, littleEndian: false },
  ]) {
    assert.deepEqual(parseMachODylibs(buildFixtureImage(variant)), TWO_DYLIBS);
  }
});

test('parseMachODylibs reads a fat image in both endiannesses', () => {
  const image = buildFixtureImage();
  assert.deepEqual(
    parseMachODylibs(buildFat({ bigEndian: true, slices: [image, image] })),
    TWO_DYLIBS
  );
  assert.deepEqual(parseMachODylibs(buildFat({ bigEndian: false, slices: [image] })), TWO_DYLIBS);
});

test('parseMachODylibs rejects a non-Mach-O buffer and an oversized image', () => {
  assert.throws(() => parseMachODylibs(Buffer.from('this is not a mach-o file')), /Mach-O/);

  const oversizedTable = Buffer.from(buildFixtureImage());
  oversizedTable.writeUInt32LE(0x100000, 20);
  assert.throws(() => parseMachODylibs(oversizedTable), /exceed/);

  const header = Buffer.alloc(32);
  header.writeUInt32BE(0xcffaedfe, 0);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(8 + 24, 20);
  const command = dylibCommand(LC_LOAD_DYLIB, '@rpath/libOversized.dylib', true);
  command.writeUInt32LE(0x100000, 4);
  assert.throws(() => parseMachODylibs(Buffer.concat([header, command])), /exceed/);
});

test('parseMachODylibs rejects a fat slice that points back at the fat header', () => {
  // A fat_arch with sliceOffset 0 and sliceSize == buffer.length yields a slice
  // identical to its parent, so an unguarded walk recurses until the stack
  // overflows. It must throw the clear error instead of a RangeError.
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(1, 4);
  const arch = Buffer.alloc(20);
  arch.writeUInt32BE(0, 8);
  arch.writeUInt32BE(28, 12);
  const image = Buffer.concat([header, arch]);

  assert.throws(() => parseMachODylibs(image), /fat Mach-O slice is itself a fat image/);
});

test('parseMachODylibs rejects a dylib command too short to hold its name offset', () => {
  // cmdsize 8 ends the command, and the file, at command + 8: the lc_str name
  // offset at command + 8 is outside both, so the read must raise the file
  // error rather than a Node buffer RangeError.
  const command = Buffer.alloc(8);
  writeU32(command, 0, LC_LOAD_DYLIB, true);
  writeU32(command, 4, 8, true);

  assert.throws(
    () => parseMachODylibs(buildThin({ is64: true, littleEndian: true, commands: [command] })),
    /exceed/
  );
});

test('readIpaComponents merges load-command names with Frameworks/ bundles', () => {
  const executable = buildThin({
    is64: true,
    littleEndian: true,
    commands: [
      dylibCommand(LC_LOAD_DYLIB, '@rpath/React.framework/React', true),
      dylibCommand(LC_LOAD_DYLIB, '@rpath/libHercules.dylib', true),
    ],
  });
  const result = withZip(
    [
      ['Payload/Kilo.app/Info.plist', INFO_PLIST],
      ['Payload/Kilo.app/Kilo', executable],
      ['Payload/Kilo.app/Frameworks/React.framework/React', executable],
      ['Payload/Kilo.app/Frameworks/Sample.framework/Sample', 'binary'],
    ],
    ipaPath => readIpaComponents({ ipaPath })
  );

  assert.equal(result.appExecutable, 'Kilo');
  const byName = new Map(result.components.map(component => [component.name, component]));
  assert.deepEqual([...byName.keys()].sort(), [
    'React.framework',
    'Sample.framework',
    'libHercules.dylib',
  ]);
  assert.deepEqual(result.counts, { dylibs: 1, frameworks: 2 });

  assert.deepEqual(byName.get('React.framework'), {
    ecosystem: 'cocoapods',
    name: 'React.framework',
    version: null,
    purl: 'pkg:cocoapods/React.framework',
    extraProperties: [{ name: 'kilo:sbom:ios-kind', value: 'dylib-load-command' }],
  });
  assert.deepEqual(byName.get('Sample.framework').extraProperties, [
    { name: 'kilo:sbom:ios-kind', value: 'dynamic-framework' },
  ]);
});

test('readIpaComponents excludes OS-provided dylibs and frameworks', () => {
  const executable = buildThin({
    is64: true,
    littleEndian: true,
    commands: [
      dylibCommand(LC_LOAD_DYLIB, '/usr/lib/libSystem.B.dylib', true),
      dylibCommand(LC_LOAD_DYLIB, '/System/Library/Frameworks/UIKit.framework/UIKit', true),
      dylibCommand(LC_LOAD_DYLIB, '@rpath/React.framework/React', true),
    ],
  });
  const result = withZip(
    [
      ['Payload/Kilo.app/Info.plist', INFO_PLIST],
      ['Payload/Kilo.app/Kilo', executable],
    ],
    ipaPath => readIpaComponents({ ipaPath })
  );

  assert.deepEqual(
    result.components.map(component => component.name),
    ['React.framework']
  );
  assert.deepEqual(result.counts, { dylibs: 0, frameworks: 1 });
});

test('readIpaComponents rejects an IPA without a Payload bundle', () => {
  assert.throws(
    () => withZip([['META-INF/MANIFEST.MF', '']], ipaPath => readIpaComponents({ ipaPath })),
    /Payload/
  );
});

test('comparePodfileLock reports declared, visible and missing pods', () => {
  const podfileLock = `PODS:
  - ExpoModulesCore (1.5.0)
  - MissingPod (9.9.9)
  - React (0.72.0)

DEPENDENCIES:
  - React (from \`../node_modules/react-native\`)
  - ExpoModulesCore (from \`../node_modules/expo-modules-core\`)

COCOAPODS: 1.14.3
`;
  const work = mkdtempSync(join(tmpdir(), 'kilo-podfile-test-'));
  const podfileLockPath = join(work, 'Podfile.lock');
  try {
    writeFileSync(podfileLockPath, podfileLock);
    const result = comparePodfileLock({
      podfileLockPath,
      components: [
        { name: 'React.framework' },
        { name: 'ExpoModulesCore' },
        { name: 'Unrelated.framework' },
      ],
    });
    assert.deepEqual(result, { declaredCount: 3, visibleCount: 2, missing: ['MissingPod'] });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('comparePodfileLock collapses sub-specs and stops at the next section', () => {
  const podfileLock = `PODS:
  - ExpoImagePicker/Core (1.0.0)
  - ExpoImagePicker/Expo (1.0.0)

DEPENDENCIES:
  - NotInPods (1.0.0)
`;
  const work = mkdtempSync(join(tmpdir(), 'kilo-podfile-test-'));
  const podfileLockPath = join(work, 'Podfile.lock');
  try {
    writeFileSync(podfileLockPath, podfileLock);
    const result = comparePodfileLock({
      podfileLockPath,
      components: [{ name: 'ExpoImagePicker' }],
    });
    assert.deepEqual(result, { declaredCount: 1, visibleCount: 1, missing: [] });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
