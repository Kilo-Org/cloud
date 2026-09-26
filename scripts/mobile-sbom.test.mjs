import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { generateMobileSboms } from './mobile-sbom.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const METADATA_ENTRY = 'BUNDLE-METADATA/com.android.tools.build.libraries/dependencies.pb';

const APP_VERSION = '1.0.12';
const IOS_BUILD_NUMBER = '42';
const ANDROID_BUILD_NUMBER = '43';
const IOS_BUILD_ID = '11111111-2222-3333-4444-555555555555';
const ANDROID_BUILD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// Stands in for the signed token an applicationArchiveUrl carries; it must never
// reach an output file.
const TOKEN = 'application-archive-token-secret';

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

const PODFILE_LOCK = `PODS:
  - React (0.72.0)
  - MissingPod (9.9.9)

DEPENDENCIES:
  - React (from \`../node_modules/react-native\`)

COCOAPODS: 1.14.3
`;

// ---- Minimal ZIP writer (copied from scripts/inspect-mobile-artifacts.test.mjs
// lines 23-104) so the fixtures are synthesized in-test and no binary artifact
// is committed. Only needs the system `unzip` the readers already rely on.

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

// ---- Synthetic Mach-O image and Info.plist (from scripts/mobile-sbom-ipa.test.mjs).

const LC_LOAD_DYLIB = 0x0c;

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

function buildThin({ is64, littleEndian, commands }) {
  const headerSize = is64 ? 32 : 28;
  const commandsBuffer = Buffer.concat(commands);
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(littleEndian ? 0xcffaedfe : 0xfeedfacf, 0);
  writeU32(header, 16, commands.length, littleEndian);
  writeU32(header, 20, commandsBuffer.length, littleEndian);
  return Buffer.concat([header, commandsBuffer]);
}

function ipaEntries() {
  const executable = buildThin({
    is64: true,
    littleEndian: true,
    commands: [
      dylibCommand(LC_LOAD_DYLIB, '@rpath/React.framework/React', true),
      dylibCommand(LC_LOAD_DYLIB, '@rpath/libHercules.dylib', true),
    ],
  });
  return [
    ['Payload/Kilo.app/Info.plist', INFO_PLIST],
    ['Payload/Kilo.app/Kilo', executable],
    ['Payload/Kilo.app/Frameworks/React.framework/React', executable],
    ['Payload/Kilo.app/Frameworks/Sample.framework/Sample', 'binary'],
  ];
}

// ---- Synthetic protobuf metadata (from scripts/mobile-sbom-aab.test.mjs).

const DIGEST_BYTES = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

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

function mavenLibraryMessage({ groupId, artifactId, version, packaging }) {
  const parts = [bytesField(1, groupId), bytesField(2, artifactId)];
  if (packaging !== undefined) {
    parts.push(bytesField(3, packaging));
  }
  parts.push(bytesField(5, version));
  return Buffer.concat(parts);
}

// A top-level AppDependencies.library entry (field 1).
function libraryField({ maven, digests }) {
  const parts = [];
  if (maven) {
    parts.push(messageField(1, [maven]));
  }
  if (digests) {
    parts.push(messageField(2, [bytesField(1, digests)]));
  }
  return messageField(1, parts);
}

function aabEntries({ corruptAabMetadata = false } = {}) {
  // A truncated varint: the reader rejects it rather than emitting a partial SBOM.
  const metadata = corruptAabMetadata
    ? Buffer.from([0x0a, 0x80])
    : libraryField({
        maven: mavenLibraryMessage({
          groupId: 'com.example',
          artifactId: 'alpha',
          version: '1.2.3',
          packaging: 'aar',
        }),
        digests: DIGEST_BYTES,
      });
  return [
    [METADATA_ENTRY, metadata],
    ['base/lib/arm64-v8a/libfoo.so', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ];
}

// ---- Fixture directory and helpers.

function buildRecords({
  omitIosBuildNumber = false,
  omitIosId = false,
  iosStatus = 'FINISHED',
} = {}) {
  const ios = {
    platform: 'IOS',
    status: iosStatus,
    id: IOS_BUILD_ID,
    appVersion: APP_VERSION,
    appBuildVersion: IOS_BUILD_NUMBER,
    artifacts: { applicationArchiveUrl: `https://example.invalid/${TOKEN}/app.ipa` },
  };
  if (omitIosBuildNumber) {
    delete ios.appBuildVersion;
  }
  if (omitIosId) {
    delete ios.id;
  }
  return [
    ios,
    {
      platform: 'ANDROID',
      status: 'FINISHED',
      id: ANDROID_BUILD_ID,
      appVersion: APP_VERSION,
      appBuildVersion: ANDROID_BUILD_NUMBER,
      artifacts: { applicationArchiveUrl: `https://example.invalid/${TOKEN}/app.aab` },
    },
  ];
}

function withFixture(options, run) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-sbom-cli-test-'));
  const ipaPath = join(work, 'app.ipa');
  const aabPath = join(work, 'app.aab');
  const buildJsonPath = join(work, 'build.json');
  const outDir = join(work, 'out');
  mkdirSync(outDir, { recursive: true });
  writeZip(ipaPath, ipaEntries());
  writeZip(aabPath, aabEntries({ corruptAabMetadata: options.corruptAabMetadata }));
  writeFileSync(buildJsonPath, JSON.stringify(options.buildJson ?? buildRecords()));
  try {
    return run({ work, ipaPath, aabPath, buildJsonPath, outDir });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function runCli(args) {
  return spawnSync('node', ['scripts/mobile-sbom.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function cyclonedxFiles(dir) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.cyclonedx.json'))
    .sort();
}

function metaProperty(document, name) {
  return document.metadata.properties.find(property => property.name === name)?.value;
}

function componentEcosystems(document) {
  const ecosystems = new Set();
  for (const component of document.components) {
    const property = component.properties.find(item => item.name === 'kilo:sbom:ecosystem');
    if (property) {
      ecosystems.add(property.value);
    }
  }
  return ecosystems;
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('writes one CycloneDX document per platform with the ecosystems that platform ships', () => {
  withFixture({}, ({ ipaPath, aabPath, buildJsonPath, outDir }) => {
    const { ios, android } = generateMobileSboms({ ipaPath, aabPath, buildJsonPath, outDir });

    assert.equal(ios.sbomFile, 'kilo-app-ios-1.0.12-build42.cyclonedx.json');
    assert.equal(android.sbomFile, 'kilo-app-android-1.0.12-build43.cyclonedx.json');
    assert.deepEqual(cyclonedxFiles(outDir), [android.sbomFile, ios.sbomFile].sort());

    const iosDocument = JSON.parse(readFileSync(join(outDir, ios.sbomFile), 'utf8'));
    const androidDocument = JSON.parse(readFileSync(join(outDir, android.sbomFile), 'utf8'));
    assert.equal(iosDocument.bomFormat, 'CycloneDX');
    assert.equal(androidDocument.bomFormat, 'CycloneDX');

    const iosEcosystems = componentEcosystems(iosDocument);
    assert.equal(iosEcosystems.has('npm'), true);
    assert.equal(iosEcosystems.has('cocoapods'), true);
    assert.equal(iosEcosystems.has('maven'), false);
    assert.equal(iosEcosystems.has('native-library'), false);

    const androidEcosystems = componentEcosystems(androidDocument);
    assert.equal(androidEcosystems.has('npm'), true);
    assert.equal(androidEcosystems.has('maven'), true);
    assert.equal(androidEcosystems.has('native-library'), true);
    assert.equal(androidEcosystems.has('cocoapods'), false);

    const iosNames = iosDocument.components.map(component => component.name);
    for (const name of ['React.framework', 'Sample.framework', 'libHercules.dylib']) {
      assert.equal(iosNames.includes(name), true, `ios document is missing ${name}`);
    }

    // The EAS artifact URL carries a download token; it must never reach an output file.
    assert.equal(JSON.stringify(iosDocument).includes(TOKEN), false);
    assert.equal(JSON.stringify(androidDocument).includes(TOKEN), false);

    // The per-ecosystem counts describe the documents that were written.
    assert.equal(ios.counts.npm, iosDocument.components.length - ios.counts.cocoapods);
    assert.equal(
      android.counts.npm + android.counts.maven + android.counts['native-library'],
      androidDocument.components.length
    );
  });
});

test('links each document to its artifact bytes and its build record', () => {
  withFixture({}, ({ ipaPath, aabPath, buildJsonPath, outDir }) => {
    const { ios, android } = generateMobileSboms({ ipaPath, aabPath, buildJsonPath, outDir });
    const iosDocument = JSON.parse(readFileSync(join(outDir, ios.sbomFile), 'utf8'));
    const androidDocument = JSON.parse(readFileSync(join(outDir, android.sbomFile), 'utf8'));

    assert.equal(metaProperty(iosDocument, 'kilo:sbom:artifact-sha256'), fileSha256(ipaPath));
    assert.equal(metaProperty(iosDocument, 'kilo:sbom:platform'), 'ios');
    assert.equal(metaProperty(iosDocument, 'kilo:sbom:app-version'), APP_VERSION);
    assert.equal(metaProperty(iosDocument, 'kilo:sbom:build-number'), IOS_BUILD_NUMBER);
    assert.equal(metaProperty(iosDocument, 'kilo:sbom:eas-build-id'), IOS_BUILD_ID);
    assert.equal(iosDocument.metadata.component.version, APP_VERSION);

    assert.equal(metaProperty(androidDocument, 'kilo:sbom:artifact-sha256'), fileSha256(aabPath));
    assert.equal(metaProperty(androidDocument, 'kilo:sbom:platform'), 'android');
    assert.equal(metaProperty(androidDocument, 'kilo:sbom:app-version'), APP_VERSION);
    assert.equal(metaProperty(androidDocument, 'kilo:sbom:build-number'), ANDROID_BUILD_NUMBER);
    assert.equal(metaProperty(androidDocument, 'kilo:sbom:eas-build-id'), ANDROID_BUILD_ID);
    assert.equal(androidDocument.metadata.component.version, APP_VERSION);

    const summary = JSON.parse(readFileSync(join(outDir, 'mobile-sbom-summary.json'), 'utf8'));
    assert.deepEqual(summary.ios, {
      platform: 'ios',
      artifactName: 'app.ipa',
      artifactSha256: fileSha256(ipaPath),
      appVersion: APP_VERSION,
      appBuildVersion: IOS_BUILD_NUMBER,
      easBuildId: IOS_BUILD_ID,
      sbomFile: ios.sbomFile,
      counts: {
        npm: ios.counts.npm,
        cocoapods: ios.counts.cocoapods,
        maven: 0,
        'native-library': 0,
      },
    });
    assert.deepEqual(summary.android, {
      platform: 'android',
      artifactName: 'app.aab',
      artifactSha256: fileSha256(aabPath),
      appVersion: APP_VERSION,
      appBuildVersion: ANDROID_BUILD_NUMBER,
      easBuildId: ANDROID_BUILD_ID,
      sbomFile: android.sbomFile,
      counts: {
        npm: android.counts.npm,
        cocoapods: 0,
        maven: 1,
        'native-library': 1,
      },
    });
    assert.equal(summary.ios.counts.npm > 0, true);
    assert.equal(JSON.stringify(summary).includes(TOKEN), false);
  });
});

test('a missing artifact or an incomplete build record fails without writing an SBOM', () => {
  withFixture({}, ({ work, aabPath, buildJsonPath, outDir }) => {
    const missing = runCli([
      '--ipa',
      join(work, 'missing.ipa'),
      '--aab',
      aabPath,
      '--build-json',
      buildJsonPath,
      '--out-dir',
      outDir,
    ]);
    assert.notEqual(missing.status, 0);
    assert.deepEqual(cyclonedxFiles(outDir), []);
  });

  withFixture({ buildJson: buildRecords({ omitIosBuildNumber: true }) }, fixture => {
    const result = runCli([
      '--ipa',
      fixture.ipaPath,
      '--aab',
      fixture.aabPath,
      '--build-json',
      fixture.buildJsonPath,
      '--out-dir',
      fixture.outDir,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /appBuildVersion/);
    assert.deepEqual(cyclonedxFiles(fixture.outDir), []);
  });

  withFixture({ buildJson: buildRecords({ omitIosId: true }) }, fixture => {
    const result = runCli([
      '--ipa',
      fixture.ipaPath,
      '--aab',
      fixture.aabPath,
      '--build-json',
      fixture.buildJsonPath,
      '--out-dir',
      fixture.outDir,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has no id/);
    assert.deepEqual(cyclonedxFiles(fixture.outDir), []);
  });

  withFixture({ buildJson: buildRecords({ iosStatus: 'IN_PROGRESS' }) }, fixture => {
    const result = runCli([
      '--ipa',
      fixture.ipaPath,
      '--aab',
      fixture.aabPath,
      '--build-json',
      fixture.buildJsonPath,
      '--out-dir',
      fixture.outDir,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FINISHED/);
    assert.deepEqual(cyclonedxFiles(fixture.outDir), []);
  });
});

test('corrupted dependencies.pb fails loudly and writes no document', () => {
  withFixture({ corruptAabMetadata: true }, ({ ipaPath, aabPath, buildJsonPath, outDir }) => {
    const result = runCli([
      '--ipa',
      ipaPath,
      '--aab',
      aabPath,
      '--build-json',
      buildJsonPath,
      '--out-dir',
      outDir,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dependencies\.pb/);
    assert.deepEqual(cyclonedxFiles(outDir), []);
    assert.equal(existsSync(join(outDir, 'mobile-sbom-summary.json')), false);
  });
});

test('the CLI writes both documents, prints them, and rejects a missing --build-json', () => {
  withFixture({}, ({ ipaPath, aabPath, buildJsonPath, outDir }) => {
    const stdout = execFileSync(
      'node',
      [
        'scripts/mobile-sbom.mjs',
        '--ipa',
        ipaPath,
        '--aab',
        aabPath,
        '--build-json',
        buildJsonPath,
        '--out-dir',
        outDir,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    assert.match(stdout, /kilo-app-ios-1\.0\.12-build42\.cyclonedx\.json/);
    assert.match(stdout, /kilo-app-android-1\.0\.12-build43\.cyclonedx\.json/);
    assert.deepEqual(cyclonedxFiles(outDir), [
      'kilo-app-android-1.0.12-build43.cyclonedx.json',
      'kilo-app-ios-1.0.12-build42.cyclonedx.json',
    ]);

    const missing = runCli(['--ipa', ipaPath, '--aab', aabPath, '--out-dir', outDir]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Usage/);
  });
});

test('the CLI prints the Podfile.lock coverage gap when --podfile-lock is given', () => {
  withFixture({}, ({ work, ipaPath, aabPath, buildJsonPath, outDir }) => {
    const podfileLockPath = join(work, 'Podfile.lock');
    writeFileSync(podfileLockPath, PODFILE_LOCK);
    const stdout = execFileSync(
      'node',
      [
        'scripts/mobile-sbom.mjs',
        '--ipa',
        ipaPath,
        '--aab',
        aabPath,
        '--build-json',
        buildJsonPath,
        '--out-dir',
        outDir,
        '--podfile-lock',
        podfileLockPath,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    assert.match(stdout, /ios podfile-lock: declared=2 visible=1 missing=\[MissingPod\]/);
  });
});
