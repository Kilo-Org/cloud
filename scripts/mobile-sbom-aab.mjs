/**
 * Android AAB dependency reader for the per-artifact mobile SBOM.
 *
 * Reads the resolved-dependency metadata the Android Gradle Plugin writes into
 * every App Bundle at BUNDLE-METADATA/com.android.tools.build.libraries/
 * dependencies.pb, plus the native libraries the bundle ships under
 * base/lib/<abi>/, and turns both into SBOM components.
 *
 * parseAppDependencies is a direct protobuf wire reader for the handful of
 * fields in com.android.bundle.AppDependencies. protobufjs sits in the
 * lockfile, but it is not a declared dependency of the root package or of
 * apps/mobile, so importing it would pull a transitively resolved package into
 * the release path; the message is small and fixed, so this reads it directly.
 *
 * The schema, read from the generated descriptor inside
 * bundletool-all-1.18.3.jar:
 *
 *   message AppDependencies {
 *     repeated Library library = 1;
 *     repeated LibraryDependencies library_dependencies = 2;
 *     repeated ModuleDependencies module_dependencies = 3;
 *     repeated Repository repositories = 4;
 *   }
 *   message Library {
 *     MavenLibrary maven_library = 1;   // oneof with unity_library = 4
 *     Digests digests = 2;
 *     google.protobuf.Int32Value repo_index = 3;
 *   }
 *   message MavenLibrary {
 *     string group_id = 1; string artifact_id = 2; string packaging = 3;
 *     string classifier = 4; string version = 5;
 *   }
 *   message UnityLibrary { string package_name = 1; string version = 2; }
 *   message Library.Digests { bytes sha256 = 1; }
 *   message LibraryDependencies {
 *     int32 library_index = 1; repeated int32 library_dep_index = 2;
 *   }
 */
import { execFileSync } from 'node:child_process';

export const AAB_METADATA_ENTRY =
  'BUNDLE-METADATA/com.android.tools.build.libraries/dependencies.pb';

const NATIVE_LIBRARY_RE = /^base\/lib\/([^/]+)\/([^/]+\.so)$/;
const READ_BUFFER_BYTES = 64 * 1024 * 1024;

function invalid(reason, byte) {
  throw new Error(
    `dependencies.pb is not a valid AppDependencies message (${reason} at byte ${byte})`
  );
}

function readVarint(buffer, state, base) {
  const start = base + state.offset;
  let value = 0;
  let scale = 1;
  for (;;) {
    if (state.offset >= buffer.length) {
      invalid('truncated varint', start);
    }
    const byte = buffer[state.offset];
    state.offset += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      return value;
    }
    scale *= 128;
    if (scale > Number.MAX_SAFE_INTEGER) {
      invalid('varint too long', start);
    }
  }
}

function readKey(buffer, state, base) {
  const key = readVarint(buffer, state, base);
  return { fieldNumber: Math.floor(key / 8), wireType: key % 8 };
}

function readLengthDelimited(buffer, state, base) {
  const lengthAt = base + state.offset;
  const length = readVarint(buffer, state, base);
  if (length > buffer.length - state.offset) {
    invalid('length past buffer end', lengthAt);
  }
  const start = base + state.offset;
  const bytes = buffer.subarray(state.offset, state.offset + length);
  state.offset += length;
  return { bytes, start };
}

function skipFixed(buffer, state, base, width) {
  const at = base + state.offset;
  if (state.offset + width > buffer.length) {
    invalid('field past buffer end', at);
  }
  state.offset += width;
}

// Unknown fields are skipped by wire type so a newer schema version cannot
// derail the read: 0 varint, 1 64-bit, 2 length-delimited, 5 32-bit.
function skipField(buffer, state, wireType, base) {
  if (wireType === 0) {
    readVarint(buffer, state, base);
    return;
  }
  if (wireType === 1) {
    skipFixed(buffer, state, base, 8);
    return;
  }
  if (wireType === 2) {
    readLengthDelimited(buffer, state, base);
    return;
  }
  if (wireType === 5) {
    skipFixed(buffer, state, base, 4);
    return;
  }
  invalid(`unsupported wire type ${wireType}`, base + state.offset);
}

function readString(buffer, state, base) {
  return readLengthDelimited(buffer, state, base).bytes.toString('utf8');
}

function parseMavenLibrary(buffer, base) {
  const state = { offset: 0 };
  const library = { groupId: '', artifactId: '', packaging: '', classifier: '', version: '' };
  const stringFields = [
    [1, 'groupId'],
    [2, 'artifactId'],
    [3, 'packaging'],
    [4, 'classifier'],
    [5, 'version'],
  ];
  while (state.offset < buffer.length) {
    const { fieldNumber, wireType } = readKey(buffer, state, base);
    const match = wireType === 2 ? stringFields.find(([number]) => number === fieldNumber) : null;
    if (match) {
      library[match[1]] = readString(buffer, state, base);
    } else {
      skipField(buffer, state, wireType, base);
    }
  }
  return library;
}

function parseUnityLibrary(buffer, base) {
  const state = { offset: 0 };
  const library = { packageName: '', version: '' };
  while (state.offset < buffer.length) {
    const { fieldNumber, wireType } = readKey(buffer, state, base);
    if (wireType === 2 && fieldNumber === 1) {
      library.packageName = readString(buffer, state, base);
    } else if (wireType === 2 && fieldNumber === 2) {
      library.version = readString(buffer, state, base);
    } else {
      skipField(buffer, state, wireType, base);
    }
  }
  return library;
}

function parseDigests(buffer, base) {
  const state = { offset: 0 };
  let sha256 = null;
  while (state.offset < buffer.length) {
    const { fieldNumber, wireType } = readKey(buffer, state, base);
    if (wireType === 2 && fieldNumber === 1) {
      sha256 = readLengthDelimited(buffer, state, base).bytes;
    } else {
      skipField(buffer, state, wireType, base);
    }
  }
  return sha256;
}

// A Library with neither oneof field set cannot be represented in the SBOM, so
// it is an error rather than a silently dropped entry.
function parseLibraryEntry(buffer, base) {
  const state = { offset: 0 };
  let mavenLibrary = null;
  let unityLibrary = null;
  let sha256 = null;
  while (state.offset < buffer.length) {
    const { fieldNumber, wireType } = readKey(buffer, state, base);
    if (wireType === 2 && fieldNumber === 1) {
      const { bytes, start } = readLengthDelimited(buffer, state, base);
      mavenLibrary = parseMavenLibrary(bytes, start);
    } else if (wireType === 2 && fieldNumber === 2) {
      const { bytes, start } = readLengthDelimited(buffer, state, base);
      sha256 = parseDigests(bytes, start);
    } else if (wireType === 2 && fieldNumber === 4) {
      const { bytes, start } = readLengthDelimited(buffer, state, base);
      unityLibrary = parseUnityLibrary(bytes, start);
    } else {
      skipField(buffer, state, wireType, base);
    }
  }
  if (mavenLibrary) {
    return { maven: mavenLibrary, sha256 };
  }
  if (unityLibrary) {
    return { unity: unityLibrary };
  }
  invalid('library entry with neither maven_library nor unity_library', base);
}

function parseLibraryDependencies(buffer, base) {
  const state = { offset: 0 };
  const edge = { libraryIndex: 0, dependencyIndices: [] };
  while (state.offset < buffer.length) {
    const { fieldNumber, wireType } = readKey(buffer, state, base);
    if (fieldNumber === 1 && wireType === 0) {
      edge.libraryIndex = readVarint(buffer, state, base);
    } else if (fieldNumber === 2 && wireType === 0) {
      edge.dependencyIndices.push(readVarint(buffer, state, base));
    } else if (fieldNumber === 2 && wireType === 2) {
      // proto3 packs repeated int32 by default; accept both encodings.
      const { bytes, start } = readLengthDelimited(buffer, state, base);
      const packed = { offset: 0 };
      while (packed.offset < bytes.length) {
        edge.dependencyIndices.push(readVarint(bytes, packed, start));
      }
    } else {
      skipField(buffer, state, wireType, base);
    }
  }
  return edge;
}

/**
 * Reads an AppDependencies protobuf message (the bytes of dependencies.pb).
 * Throws on a truncated varint, a length past the buffer end, a Library with
 * no oneof payload, or a message with no Library entry at all; it never
 * returns a partial parse.
 *
 * @param {Buffer} buffer
 * @returns {{ libraries: Array<{ groupId: string, artifactId: string, version: string,
 *   packaging: string, classifier: string, sha256: string|null }>,
 *   unityLibraries: Array<{ packageName: string, version: string }>,
 *   libraryDependencies: Array<{ libraryIndex: number, dependencyIndices: number[] }> }}
 */
export function parseAppDependencies(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const state = { offset: 0 };
  const libraries = [];
  const unityLibraries = [];
  const libraryDependencies = [];
  let libraryEntries = 0;
  while (state.offset < bytes.length) {
    const { fieldNumber, wireType } = readKey(bytes, state, 0);
    if (fieldNumber === 1 && wireType === 2) {
      libraryEntries += 1;
      const { bytes: payload, start } = readLengthDelimited(bytes, state, 0);
      const entry = parseLibraryEntry(payload, start);
      if (entry.maven) {
        libraries.push({
          groupId: entry.maven.groupId,
          artifactId: entry.maven.artifactId,
          version: entry.maven.version,
          packaging: entry.maven.packaging,
          classifier: entry.maven.classifier,
          sha256: entry.sha256 ? entry.sha256.toString('hex') : null,
        });
      } else {
        unityLibraries.push(entry.unity);
      }
    } else if (fieldNumber === 2 && wireType === 2) {
      const { bytes: payload, start } = readLengthDelimited(bytes, state, 0);
      libraryDependencies.push(parseLibraryDependencies(payload, start));
    } else {
      skipField(bytes, state, wireType, 0);
    }
  }
  if (libraryEntries === 0) {
    invalid('no library entry', 0);
  }
  return { libraries, unityLibraries, libraryDependencies };
}

function mavenComponent(library) {
  const extraProperties = [];
  if (library.packaging) {
    extraProperties.push({ name: 'kilo:sbom:maven-packaging', value: library.packaging });
  }
  if (library.classifier) {
    extraProperties.push({ name: 'kilo:sbom:maven-classifier', value: library.classifier });
  }
  return {
    ecosystem: 'maven',
    name: `${library.groupId}:${library.artifactId}`,
    version: library.version,
    purl: `pkg:maven/${library.groupId}/${library.artifactId}@${library.version}`,
    hashes: library.sha256 ? [{ alg: 'SHA-256', content: library.sha256 }] : [],
    extraProperties,
  };
}

function nativeLibraryComponent(name, abi, entry) {
  return {
    ecosystem: 'native-library',
    name,
    version: null,
    purl: `pkg:generic/${name}`,
    extraProperties: [
      { name: 'kilo:sbom:abi', value: abi },
      { name: 'kilo:sbom:aab-path', value: entry },
    ],
  };
}

function run(cmd, args, options) {
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}

// The listing is unbounded, so it uses the same raised cap as the entry read:
// a release AAB's `unzip -Z1` output can pass Node's 1 MiB default.
function listAabEntries(aabPath) {
  return run('unzip', ['-Z1', aabPath], { encoding: 'utf8', maxBuffer: READ_BUFFER_BYTES })
    .split('\n')
    .filter(entry => entry.length > 0);
}

// No encoding: unzip -p emits the raw protobuf bytes, which are not UTF-8.
function readAabEntry(aabPath, entry) {
  return run('unzip', ['-p', aabPath, entry], { maxBuffer: READ_BUFFER_BYTES });
}

/**
 * Reads the shipped AAB itself: the resolved Maven dependencies from the
 * Gradle Plugin metadata, and the native .so libraries under base/lib/<abi>/.
 *
 * @param {{ aabPath: string }} options
 * @returns {{ components: object[], counts: { maven: number, nativeLibraries: number } }}
 */
export function readAabComponents({ aabPath }) {
  const entries = listAabEntries(aabPath);
  if (!entries.includes(AAB_METADATA_ENTRY)) {
    throw new Error(`AAB has no ${AAB_METADATA_ENTRY}`);
  }
  const { libraries } = parseAppDependencies(readAabEntry(aabPath, AAB_METADATA_ENTRY));
  const components = libraries.map(mavenComponent);
  let nativeLibraries = 0;
  for (const entry of entries) {
    const match = NATIVE_LIBRARY_RE.exec(entry);
    if (match) {
      nativeLibraries += 1;
      components.push(nativeLibraryComponent(match[2], match[1], entry));
    }
  }
  components.sort((a, b) => a.name.localeCompare(b.name) || a.purl.localeCompare(b.purl));
  return {
    components,
    counts: { maven: libraries.length, nativeLibraries },
  };
}
