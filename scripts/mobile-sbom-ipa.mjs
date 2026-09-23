#!/usr/bin/env node
/**
 * iOS ecosystem reader for the per-artifact SBOM.
 *
 * The shipped IPA is the source, not apps/mobile/ios/Podfile.lock: Expo CNG
 * generates apps/mobile/ios (nothing under it is tracked in git) and
 * `pod install` needs macOS, which the ubuntu release runner does not have.
 *
 * Exports:
 *   parseMachODylibs(buffer)        pure Mach-O LC_LOAD_DYLIB/weak/reexport/upward reader
 *   readIpaComponents({ ipaPath })  unzip the IPA, walk the app executable and Frameworks/
 *   comparePodfileLock(...)         gap measurement against a real Podfile.lock (printed only)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mach-O magic numbers as read by readUInt32BE(0): the big-endian pair means
// the file's fields are big-endian, the CIGAM pair means little-endian.
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM = 0xcefaedfe;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;

const THIN_MAGICS = new Map([
  [MH_MAGIC, { is64: false, littleEndian: false }],
  [MH_MAGIC_64, { is64: true, littleEndian: false }],
  [MH_CIGAM, { is64: false, littleEndian: true }],
  [MH_CIGAM_64, { is64: true, littleEndian: true }],
]);

const LC_LOAD_DYLIB = 0x0c;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const DYLIB_LOAD_COMMANDS = new Set([
  LC_LOAD_DYLIB,
  LC_LOAD_WEAK_DYLIB,
  LC_REEXPORT_DYLIB,
  LC_LOAD_UPWARD_DYLIB,
]);

const EXCEEDS_FILE = 'Mach-O load commands exceed the file size';
// A universal image's slices are thin Mach-O images. A slice that is itself fat
// can only be a self-reference (a malformed fat_arch pointing back at the fat
// header), which would otherwise recurse until the stack overflows.
const FAT_NESTED = 'fat Mach-O slice is itself a fat image';
const MAX_FAT_DEPTH = 1;
const KILO_IOS_KIND = 'kilo:sbom:ios-kind';
const KIND_LOAD_COMMAND = 'dylib-load-command';
const KIND_DYNAMIC_FRAMEWORK = 'dynamic-framework';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function readU32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function unknownMagic(magic) {
  const hex = magic === undefined ? '<file too short>' : `0x${magic.toString(16).padStart(8, '0')}`;
  return new Error(`not a Mach-O binary (magic ${hex})`);
}

/**
 * Read the install names of every dylib the image links at load time, in file
 * order and deduped. Thin 32/64-bit images in both endiannesses and fat
 * (universal) images are supported; a malformed image, including one whose
 * fat_arch points back at its own fat header, throws instead of returning a
 * partial list.
 */
export function parseMachODylibs(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('parseMachODylibs: buffer must be a Buffer');
  }
  const names = [];
  const seen = new Set();
  walkMachO(buffer, names, seen, 0);
  return names;
}

function walkMachO(buffer, names, seen, depth) {
  if (buffer.length < 4) {
    throw unknownMagic(undefined);
  }
  const magic = buffer.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_CIGAM) {
    if (depth >= MAX_FAT_DEPTH) {
      throw new Error(FAT_NESTED);
    }
    walkFat(buffer, magic === FAT_MAGIC, names, seen, depth);
    return;
  }
  const variant = THIN_MAGICS.get(magic);
  if (!variant) {
    throw unknownMagic(magic);
  }
  walkThin(buffer, variant, names, seen);
}

function walkFat(buffer, bigEndian, names, seen, depth) {
  const littleEndian = !bigEndian;
  if (buffer.length < 8) {
    throw new Error(EXCEEDS_FILE);
  }
  const nfatArch = readU32(buffer, 4, littleEndian);
  let entry = 8;
  for (let index = 0; index < nfatArch; index += 1) {
    if (entry + 20 > buffer.length) {
      throw new Error(EXCEEDS_FILE);
    }
    const sliceOffset = readU32(buffer, entry + 8, littleEndian);
    const sliceSize = readU32(buffer, entry + 12, littleEndian);
    entry += 20;
    if (sliceSize === 0) {
      continue;
    }
    if (sliceOffset + sliceSize > buffer.length) {
      throw new Error(EXCEEDS_FILE);
    }
    walkMachO(buffer.subarray(sliceOffset, sliceOffset + sliceSize), names, seen, depth + 1);
  }
}

function walkThin(buffer, { is64, littleEndian }, names, seen) {
  // 64-bit Mach-O headers are 32 bytes, 32-bit headers 28; ncmds sits at
  // offset 16 and sizeofcmds at 20 in both.
  const headerSize = is64 ? 32 : 28;
  if (buffer.length < headerSize) {
    throw new Error(EXCEEDS_FILE);
  }
  const ncmds = readU32(buffer, 16, littleEndian);
  const sizeofcmds = readU32(buffer, 20, littleEndian);
  const commandsEnd = headerSize + sizeofcmds;
  if (commandsEnd > buffer.length) {
    throw new Error(EXCEEDS_FILE);
  }
  let offset = headerSize;
  for (let index = 0; index < ncmds; index += 1) {
    if (offset + 8 > commandsEnd) {
      throw new Error(EXCEEDS_FILE);
    }
    const cmd = readU32(buffer, offset, littleEndian);
    const cmdsize = readU32(buffer, offset + 4, littleEndian);
    if (cmdsize < 8 || offset + cmdsize > commandsEnd) {
      throw new Error(EXCEEDS_FILE);
    }
    if (DYLIB_LOAD_COMMANDS.has(cmd)) {
      // dylib_command: the lc_str name offset is the uint32 at command + 8 and
      // is relative to the command start; LC_ID_DYLIB (0x0d) is the library's
      // own name, not a link, and is skipped. A real dylib_command is 24 bytes
      // (cmd, cmdsize, name offset, timestamp, and two version fields), so a
      // shorter one cannot hold that offset; reading it would run past the
      // command, and past the file when the command ends at the buffer end.
      if (cmdsize < 24) {
        throw new Error(EXCEEDS_FILE);
      }
      const nameOffset = readU32(buffer, offset + 8, littleEndian);
      const commandEnd = offset + cmdsize;
      const nameStart = offset + nameOffset;
      if (nameOffset < 8 || nameStart >= commandEnd) {
        throw new Error(EXCEEDS_FILE);
      }
      const nul = buffer.indexOf(0, nameStart);
      if (nul === -1 || nul >= commandEnd) {
        throw new Error(EXCEEDS_FILE);
      }
      const name = buffer.toString('utf8', nameStart, nul);
      if (name.length > 0 && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    offset += cmdsize;
  }
}

/**
 * Reduce a Mach-O install name to its component name: strip a dyld prefix,
 * then the last path segment (`Foo.dylib` stays `Foo.dylib`), collapsing
 * `X.framework/X` to `X.framework`.
 */
function normalizeInstallName(rawName) {
  let name = rawName;
  for (const prefix of ['@rpath/', '@executable_path/', '@loader_path/']) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  if (name.startsWith('/')) {
    name = name.slice(1);
  }
  const segments = name.split('/').filter(segment => segment.length > 0);
  if (segments.length === 0) {
    return rawName;
  }
  const last = segments[segments.length - 1];
  const previous = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  if (previous !== undefined && previous === `${last}.framework`) {
    return previous;
  }
  return last;
}

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function parseInfoPlist(plistPath) {
  // A signed IPA's Info.plist is binary. Python's plistlib stdlib handles both
  // XML and binary formats and is preinstalled on the ubuntu-latest runner.
  const script = [
    'import plistlib, json, sys',
    'with open(sys.argv[1], "rb") as f:',
    '    data = plistlib.load(f)',
    'json.dump(data, sys.stdout)',
  ].join('\n');
  return JSON.parse(run('python3', ['-c', script, plistPath]));
}

function toComponent(name, kind) {
  return {
    ecosystem: 'cocoapods',
    name,
    version: null,
    purl: `pkg:cocoapods/${name}`,
    extraProperties: [{ name: KILO_IOS_KIND, value: kind }],
  };
}

/**
 * Read every CocoaPods component the IPA carries: the app executable's
 * LC_LOAD_DYLIB family install names plus the dynamic frameworks and dylibs
 * under `Payload/<App>.app/Frameworks/`. Both sources are merged by name so a
 * framework that is both linked and shipped appears once; the kind recorded is
 * the first one that discovered it (load command before on-disk bundle).
 */
export function readIpaComponents({ ipaPath } = {}) {
  if (!isNonEmptyString(ipaPath)) {
    throw new Error('readIpaComponents: ipaPath must be a non-empty string');
  }
  const work = mkdtempSync(join(tmpdir(), 'kilo-sbom-ipa-'));
  try {
    const extractDir = join(work, 'ipa');
    mkdirSync(extractDir, { recursive: true });
    try {
      run('unzip', ['-q', '-o', ipaPath, '-d', extractDir]);
    } catch (error) {
      throw new Error(`cannot unzip IPA ${ipaPath}: ${error.message}`);
    }

    const payloadDir = join(extractDir, 'Payload');
    const appName = existsSync(payloadDir)
      ? readdirSync(payloadDir).find(entry => entry.endsWith('.app'))
      : undefined;
    if (!appName) {
      throw new Error(`IPA has no Payload/*.app bundle (checked ${payloadDir})`);
    }
    const appPath = join(payloadDir, appName);

    let plist;
    try {
      plist = parseInfoPlist(join(appPath, 'Info.plist'));
    } catch (error) {
      throw new Error(`IPA Info.plist is not parseable: ${error.message}`);
    }
    const executableName = plist.CFBundleExecutable;
    if (!isNonEmptyString(executableName)) {
      throw new Error('IPA Info.plist has no CFBundleExecutable');
    }
    const executablePath = join(appPath, executableName);
    if (!existsSync(executablePath)) {
      throw new Error(`IPA has no ${executableName} executable (checked ${executablePath})`);
    }

    const components = [];
    const added = new Set();
    const add = (name, kind) => {
      if (!isNonEmptyString(name) || added.has(name)) {
        return;
      }
      added.add(name);
      components.push(toComponent(name, kind));
    };

    for (const installName of parseMachODylibs(readFileSync(executablePath))) {
      add(normalizeInstallName(installName), KIND_LOAD_COMMAND);
    }

    const frameworksDir = join(appPath, 'Frameworks');
    if (existsSync(frameworksDir)) {
      const entries = readdirSync(frameworksDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith('.framework')) {
          add(entry.name, KIND_DYNAMIC_FRAMEWORK);
        } else if (entry.isFile() && entry.name.endsWith('.dylib')) {
          add(entry.name, KIND_DYNAMIC_FRAMEWORK);
        }
      }
    }

    let dylibs = 0;
    let frameworks = 0;
    for (const component of components) {
      if (component.name.endsWith('.framework')) {
        frameworks += 1;
      } else if (component.name.endsWith('.dylib')) {
        dylibs += 1;
      }
    }
    return { components, appExecutable: executableName, counts: { dylibs, frameworks } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseDeclaredPods(text) {
  const pods = [];
  const seen = new Set();
  let inPodsSection = false;
  for (const line of text.split(/\r?\n/)) {
    // Podfile.lock section headers are unindented; only PODS: holds the graph.
    if (/^[A-Za-z]/.test(line)) {
      inPodsSection = line === 'PODS:';
      continue;
    }
    if (!inPodsSection) {
      continue;
    }
    const match = /^ {2}- ([A-Za-z0-9_+./-]+)/.exec(line);
    if (!match) {
      continue;
    }
    // Sub-specs (`ExpoImagePicker/Core`) collapse to their pod.
    const pod = match[1].split('/')[0];
    if (!seen.has(pod)) {
      seen.add(pod);
      pods.push(pod);
    }
  }
  return pods;
}

function normalizePodName(pod) {
  return pod.toLowerCase().replace(/-/g, '_');
}

function normalizeComponentName(name) {
  const withoutFramework = name.endsWith('.framework') ? name.slice(0, -'.framework'.length) : name;
  return normalizePodName(withoutFramework);
}

/**
 * Measure how many pods a real Podfile.lock declares against the components the
 * IPA carries. This is reported only; it is never written into an SBOM, because
 * a lockfile pod that is statically linked into the executable is invisible to
 * any file scan.
 */
export function comparePodfileLock({ podfileLockPath, components } = {}) {
  if (!isNonEmptyString(podfileLockPath)) {
    throw new Error('comparePodfileLock: podfileLockPath must be a non-empty string');
  }
  if (!Array.isArray(components)) {
    throw new Error('comparePodfileLock: components must be an array');
  }
  let text;
  try {
    text = readFileSync(podfileLockPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read Podfile.lock ${podfileLockPath}: ${error.message}`);
  }
  const declared = parseDeclaredPods(text);
  const visible = new Set(
    components
      .filter(component => component && isNonEmptyString(component.name))
      .map(component => normalizeComponentName(component.name))
  );
  const missing = declared.filter(pod => !visible.has(normalizePodName(pod)));
  return {
    declaredCount: declared.length,
    visibleCount: declared.length - missing.length,
    missing: [...missing].sort(),
  };
}
