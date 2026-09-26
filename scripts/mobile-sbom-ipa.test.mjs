import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseMachODylibs,
  readIpaComponents,
  readPodfileLockComponents,
} from './mobile-sbom-ipa.mjs';

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

/** The same Info.plist for an embedded extension bundle: only the executable differs. */
function extensionInfoPlist(executable) {
  return INFO_PLIST.replace('<string>Kilo</string>', `<string>${executable}</string>`);
}

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

test('readIpaComponents includes dependencies only an embedded extension carries', () => {
  const appExecutable = buildThin({
    is64: true,
    littleEndian: true,
    commands: [dylibCommand(LC_LOAD_DYLIB, '@rpath/AppOnly.framework/AppOnly', true)],
  });
  const extensionExecutable = buildThin({
    is64: true,
    littleEndian: true,
    commands: [
      dylibCommand(LC_LOAD_DYLIB, '@rpath/ExtensionOnly.framework/ExtensionOnly', true),
      dylibCommand(LC_LOAD_DYLIB, '@executable_path/libExtOnly.dylib', true),
      // The OS supplies this one, so the extension must not report it either.
      dylibCommand(LC_LOAD_DYLIB, '/usr/lib/libSystem.B.dylib', true),
    ],
  });
  const result = withZip(
    [
      ['Payload/Kilo.app/Info.plist', INFO_PLIST],
      ['Payload/Kilo.app/Kilo', appExecutable],
      [
        'Payload/Kilo.app/PlugIns/NotificationService.appex/Info.plist',
        extensionInfoPlist('NotificationService'),
      ],
      [
        'Payload/Kilo.app/PlugIns/NotificationService.appex/NotificationService',
        extensionExecutable,
      ],
      [
        'Payload/Kilo.app/PlugIns/NotificationService.appex/Frameworks/NotifKit.framework/NotifKit',
        'binary',
      ],
    ],
    ipaPath => readIpaComponents({ ipaPath })
  );

  const byName = new Map(result.components.map(component => [component.name, component]));
  assert.deepEqual([...byName.keys()].sort(), [
    'AppOnly.framework',
    'ExtensionOnly.framework',
    'NotifKit.framework',
    'libExtOnly.dylib',
  ]);
  assert.deepEqual(byName.get('ExtensionOnly.framework').extraProperties, [
    { name: 'kilo:sbom:ios-kind', value: 'dylib-load-command' },
  ]);
  assert.deepEqual(byName.get('NotifKit.framework').extraProperties, [
    { name: 'kilo:sbom:ios-kind', value: 'dynamic-framework' },
  ]);
  assert.deepEqual(result.counts, { dylibs: 1, frameworks: 3 });
});

test('readIpaComponents falls back to the bundle name when an extension plist is unreadable', () => {
  const extensionExecutable = buildThin({
    is64: true,
    littleEndian: true,
    commands: [dylibCommand(LC_LOAD_DYLIB, '@rpath/ExtensionOnly.framework/ExtensionOnly', true)],
  });
  const result = withZip(
    [
      ['Payload/Kilo.app/Info.plist', INFO_PLIST],
      ['Payload/Kilo.app/Kilo', buildFixtureImage()],
      ['Payload/Kilo.app/PlugIns/NotificationService.appex/Info.plist', 'not a plist'],
      [
        'Payload/Kilo.app/PlugIns/NotificationService.appex/NotificationService',
        extensionExecutable,
      ],
    ],
    ipaPath => readIpaComponents({ ipaPath })
  );

  assert.deepEqual(
    result.components.map(component => component.name),
    ['libBeta.dylib', 'ExtensionOnly.framework']
  );
});

test('readIpaComponents rejects an IPA without a Payload bundle', () => {
  assert.throws(
    () => withZip([['META-INF/MANIFEST.MF', '']], ipaPath => readIpaComponents({ ipaPath })),
    /Payload/
  );
});

function withPodfileLock(text, run) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-podfile-test-'));
  const podfileLockPath = join(work, 'Podfile.lock');
  try {
    writeFileSync(podfileLockPath, text);
    return run(podfileLockPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('readPodfileLockComponents lists one versioned, hashed component per root pod', () => {
  const podfileLock = `PODS:
  - EXConstants (17.0.8):
    - ExpoModulesCore
  - hermes-engine (0.76.9):
    - hermes-engine/Pre-built (= 0.76.9)
  - hermes-engine/Pre-built (0.76.9)
  - React-Core (0.76.9):
    - React-Core/Default (= 0.76.9)
  - React-Core/Default (0.76.9):
    - glog
  - React-Core/RCTWebSocket (0.76.9)
  - "RCT-Folly (2024.10.14.00)"
  - Sentry/HybridSDK (8.48.0)

DEPENDENCIES:
  - NotAPod (from \`../node_modules/not-a-pod\`)

SPEC CHECKSUMS:
  EXConstants: fcfc75800824ac2d5c592b5bc74130bad17b146b
  hermes-engine: 06a9c6900587420b90accc394199527c64259db4
  RCT-Folly: 84578c8756030547307e4572ab1947de1685c599
  React-Core: 4f1ba1b2a3b94ba77d4b0c9d5ebcd2c9fd9d2d8e

COCOAPODS: 1.15.2
`;
  const { components } = withPodfileLock(podfileLock, podfileLockPath =>
    readPodfileLockComponents({ podfileLockPath })
  );

  assert.deepEqual(
    components.map(({ name, version, purl, hashes }) => ({ name, version, purl, hashes })),
    [
      {
        name: 'EXConstants',
        version: '17.0.8',
        purl: 'pkg:cocoapods/EXConstants@17.0.8',
        hashes: [{ alg: 'SHA-1', content: 'fcfc75800824ac2d5c592b5bc74130bad17b146b' }],
      },
      {
        name: 'hermes-engine',
        version: '0.76.9',
        purl: 'pkg:cocoapods/hermes-engine@0.76.9',
        hashes: [{ alg: 'SHA-1', content: '06a9c6900587420b90accc394199527c64259db4' }],
      },
      {
        name: 'React-Core',
        version: '0.76.9',
        purl: 'pkg:cocoapods/React-Core@0.76.9',
        hashes: [{ alg: 'SHA-1', content: '4f1ba1b2a3b94ba77d4b0c9d5ebcd2c9fd9d2d8e' }],
      },
      {
        name: 'RCT-Folly',
        version: '2024.10.14.00',
        purl: 'pkg:cocoapods/RCT-Folly@2024.10.14.00',
        hashes: [{ alg: 'SHA-1', content: '84578c8756030547307e4572ab1947de1685c599' }],
      },
      // Listed only as a subspec and absent from SPEC CHECKSUMS.
      {
        name: 'Sentry',
        version: '8.48.0',
        purl: 'pkg:cocoapods/Sentry@8.48.0',
        hashes: [],
      },
    ]
  );
  for (const component of components) {
    assert.equal(component.ecosystem, 'cocoapods');
    assert.deepEqual(component.extraProperties, [
      { name: 'kilo:sbom:ios-kind', value: 'podfile-lock' },
    ]);
  }
});

test('readPodfileLockComponents rejects a missing, empty or malformed Podfile.lock', () => {
  assert.throws(
    () => readPodfileLockComponents({ podfileLockPath: join(tmpdir(), 'kilo-missing-Podfile.lock') }),
    /cannot read Podfile\.lock/
  );
  assert.throws(
    () =>
      withPodfileLock('DEPENDENCIES:\n  - React (0.76.9)\n', podfileLockPath =>
        readPodfileLockComponents({ podfileLockPath })
      ),
    /declares no pods/
  );
  assert.throws(
    () =>
      withPodfileLock(
        'PODS:\n  - React (0.76.9)\n\nSPEC CHECKSUMS:\n  React: not-a-sha1\n',
        podfileLockPath => readPodfileLockComponents({ podfileLockPath })
      ),
    /malformed SPEC CHECKSUMS entry for React/
  );
  assert.throws(
    () =>
      withPodfileLock('PODS:\n  - React (0.76.9)\n  - React/Core (0.77.0)\n', podfileLockPath =>
        readPodfileLockComponents({ podfileLockPath })
      ),
    /locks React at both 0\.76\.9 and 0\.77\.0/
  );
});
