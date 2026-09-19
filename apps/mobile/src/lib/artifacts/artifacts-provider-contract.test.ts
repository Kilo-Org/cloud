// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  type ArtifactMirrorFile,
  type ArtifactMirrorManifest,
  type ArtifactMirrorSession,
} from '@/lib/artifacts/artifact-mirror-manifest';

// Contract guard for the Android DocumentsProvider in
// `modules/artifacts-provider`.
//
// DocumentsUI and the JS bridge depend on facts no host without a device can
// execute: the manifest authority, the signature-level permission, the
// DOCUMENTS_PROVIDER intent filter, the class names the module config and the
// module manifest agree on, the read-only refusal at every write-back entry
// point, and the mirror layout and manifest keys the Kotlin parser reads out of
// `apps/mobile/src/lib/artifacts/artifact-mirror.ts` and
// `artifact-mirror-manifest.ts`. A rename or a manifest edit fails here instead
// of on a device.

const MODULE_DIRECTORY = new URL('../../../modules/artifacts-provider/', import.meta.url);
const PROVIDER_PACKAGE = 'com.kilocode.artifactsprovider';
const PROVIDER_MODULE_CLASS = `${PROVIDER_PACKAGE}.ArtifactsProviderModule`;
const PROVIDER_CLASS = `${PROVIDER_PACKAGE}.ArtifactsDocumentsProvider`;
const APP_PACKAGE = 'com.kilocode.kiloapp';
const READ_ONLY_ENTRY_POINTS = [
  'createDocument',
  'deleteDocument',
  'renameDocument',
  'moveDocument',
];

// Mirrored by the Kotlin constants below; owned by `artifact-mirror.ts`
// (`ARTIFACT_MIRROR_DIR_NAME`, `ARTIFACT_MIRROR_SESSIONS_DIR_NAME`) and
// `artifact-mirror-paths.ts`.
const MIRROR_DIRECTORY_NAME = 'artifacts';
const MIRROR_SESSIONS_DIR_NAME = 'sessions';
const MIRROR_MANIFEST_FILE_NAME = 'manifest.json';

const readModuleFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, MODULE_DIRECTORY)), 'utf8');

const kotlinSourcePath = (className: string): string =>
  `android/src/main/java/${className.replaceAll('.', '/')}.kt`;

const moduleConfig: {
  platforms: string[];
  android: { modules: string[] };
} = JSON.parse(readModuleFile('expo-module.config.json'));
const manifestXml = readModuleFile('android/src/main/AndroidManifest.xml');
const providerSource = readModuleFile(kotlinSourcePath(PROVIDER_CLASS));
const moduleSource = readModuleFile(kotlinSourcePath(PROVIDER_MODULE_CLASS));
const appConfigSource = readFileSync(
  fileURLToPath(new URL('../../../app.config.ts', import.meta.url)),
  'utf8'
);

describe('artifacts DocumentsProvider contract', () => {
  it('registers the Android platform with the module class its source declares', () => {
    // `apple` is the File Provider module slice s6 adds; this guard covers the
    // Android half and `artifacts-file-provider-contract.test.ts` the iOS half.
    expect(moduleConfig.platforms).toEqual(['apple', 'android']);
    expect(moduleConfig.android.modules).toEqual([PROVIDER_MODULE_CLASS]);
    expect(moduleSource).toContain('class ArtifactsProviderModule : Module()');
    expect(moduleSource).toContain('Name("ArtifactsProvider")');
  });

  it('declares the provider class the module manifest names, read-only', () => {
    expect(manifestXml).toContain(`android:name="${PROVIDER_CLASS}"`);
    expect(providerSource).toContain('class ArtifactsDocumentsProvider : DocumentsProvider()');
  });

  it('scopes the provider to the application id', () => {
    expect(manifestXml).toContain(`android:authorities="\${applicationId}.artifacts"`);
    const androidPackage = /android:\s*\{[\s\S]*?package:\s*'([^']+)'/.exec(appConfigSource);
    expect(androidPackage?.[1]).toBe(APP_PACKAGE);
    // The runtime authority must equal the manifest's `${applicationId}.artifacts`.
    expect(providerSource).toContain('private const val AUTHORITY_SUFFIX = ".artifacts"');
    expect(providerSource).toContain('context.packageName + AUTHORITY_SUFFIX');
  });

  it('opens only to the system file browser through the documents intent filter', () => {
    expect(manifestXml).toContain('android:permission="android.permission.MANAGE_DOCUMENTS"');
    expect(manifestXml).toContain('android:exported="true"');
    expect(manifestXml).toContain('android:grantUriPermissions="true"');
    expect(manifestXml).toContain(
      '<action android:name="android.content.action.DOCUMENTS_PROVIDER" />'
    );
  });

  it('serves one local root titled Kilo with no create or delete flag', () => {
    expect(providerSource).toContain('const val ROOT_ID = "kilo"');
    expect(providerSource).toContain('private const val ROOT_TITLE = "Kilo"');
    expect(providerSource).toContain('Root.FLAG_LOCAL_ONLY');
  });

  it('refuses every write-back entry point', () => {
    for (const entryPoint of READ_ONLY_ENTRY_POINTS) {
      expect(providerSource).toContain(`override fun ${entryPoint}(`);
    }
    expect(providerSource).toContain('throw FileNotFoundException(READ_ONLY_MESSAGE)');
    expect(providerSource).toContain('private const val READ_ONLY_FLAGS = 0');
    expect(providerSource).toContain('row.add(Document.COLUMN_FLAGS, READ_ONLY_FLAGS)');
  });

  it('returns an empty cursor for a missing or unreadable manifest', () => {
    expect(providerSource).toContain('if (!manifest.isFile)');
    expect(providerSource).toContain('return emptyList()');
    expect(providerSource).toContain('Log.w(TAG, "Ignoring unreadable artifact manifest", error)');
  });

  it('notifies the roots URI from the JS bridge', () => {
    expect(moduleSource).toContain('Function("notifyArtifactsChanged")');
    expect(moduleSource).toContain(
      'context.contentResolver.notifyChange(ArtifactsDocumentsProvider.rootsUri(context), null)'
    );
    expect(providerSource).toContain(
      'fun rootsUri(context: Context): Uri = DocumentsContract.buildRootsUri(authority(context))'
    );
  });
});

// An inline manifest of the shape `artifactMirrorManifestSchema` writes. The
// type annotations are the compile-time half of the contract: an object literal
// with a key the schema has no home for fails `pnpm typecheck`, and a key the
// schema requires and the fixture lacks does too.
const MIRROR_MANIFEST_FILE: ArtifactMirrorFile = {
  id: 'file-1',
  name: 'report.md',
  mime: 'text/markdown',
  size: 2048,
};
const MIRROR_MANIFEST_SESSION: ArtifactMirrorSession = {
  id: 'session-1',
  title: 'Runtime settings audit',
  updatedAt: '2026-09-16T00:00:00.000Z',
  files: [MIRROR_MANIFEST_FILE],
};
const MIRROR_MANIFEST_EMPTY_SESSION: ArtifactMirrorSession = {
  id: 'session-2',
  title: 'Session without artifacts',
  updatedAt: '2026-09-16T00:00:01.000Z',
  files: [],
};
const MIRROR_MANIFEST: ArtifactMirrorManifest = {
  version: 1,
  updatedAt: '2026-09-16T00:00:01.000Z',
  sessions: [MIRROR_MANIFEST_SESSION, MIRROR_MANIFEST_EMPTY_SESSION],
};

// Every manifest key the Kotlin parser reads.
const PARSED_MANIFEST_KEYS = [
  'version',
  'sessions',
  'id',
  'title',
  'files',
  'name',
  'mime',
  'size',
];

describe('artifacts mirror manifest contract', () => {
  it('reads the layout and the manifest file the JS mirror writes', () => {
    expect(providerSource).toContain(
      `private const val ARTIFACTS_DIRECTORY_NAME = "${MIRROR_DIRECTORY_NAME}"`
    );
    expect(providerSource).toContain(
      `private const val SESSIONS_DIRECTORY_NAME = "${MIRROR_SESSIONS_DIR_NAME}"`
    );
    expect(providerSource).toContain(
      `private const val MANIFEST_FILE_NAME = "${MIRROR_MANIFEST_FILE_NAME}"`
    );
    // `<filesDir>/artifacts/sessions/<sessionId>/<fileId>`.
    expect(providerSource).toContain(
      'File(File(artifactsDirectory, SESSIONS_DIRECTORY_NAME), file.session.id)'
    );
    expect(providerSource).toContain('File(sessionDirectory, file.entry.id)');
    expect(providerSource).toContain(
      `private const val SUPPORTED_MANIFEST_VERSION = ${MIRROR_MANIFEST.version}`
    );
  });

  it('parses only manifest keys the fixture carries', () => {
    // The fixture keys are a subset of the schema's (the type annotations above
    // reject an extra key), so `version` through `size` below are the manifest's
    // keys and nothing else.
    const fixtureKeys = new Set([
      ...Object.keys(MIRROR_MANIFEST),
      ...Object.keys(MIRROR_MANIFEST_SESSION),
      ...Object.keys(MIRROR_MANIFEST_FILE),
    ]);
    for (const key of PARSED_MANIFEST_KEYS) {
      expect(providerSource).toContain(`"${key}"`);
      expect(fixtureKeys.has(key)).toBe(true);
    }
  });

  it('carries a session with no artifacts as an empty file list', () => {
    // The provider appends every session whatever its `files` array holds, so
    // an empty list is an empty folder and never a dropped session row. The
    // fixture's `files` key is checked against this source in the test above.
    expect(providerSource).toContain('val rawFiles = rawSession.optJSONArray(KEY_FILES)');
    expect(providerSource).toContain('sessions.add(ManifestSession(sessionId, title, files))');
  });
});
