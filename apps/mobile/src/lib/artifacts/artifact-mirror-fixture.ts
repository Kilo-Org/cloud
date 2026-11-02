import { File } from 'expo-file-system';

import {
  applyArtifactSnapshot,
  clearArtifactMirror,
  mirrorSessionDir,
} from '@/lib/artifacts/artifact-mirror';
import {
  ARTIFACT_MIRROR_MANIFEST_VERSION,
  type ArtifactMirrorFile,
  type ArtifactMirrorManifest,
  type ArtifactMirrorSession,
  safeArtifactDisplayName,
  safeArtifactSessionName,
  uniqueArtifactDisplayNames,
} from '@/lib/artifacts/artifact-mirror-manifest';
import {
  notifyArtifactsChanged,
  registerArtifactsProviderDomain,
} from '@/lib/artifacts/artifact-provider-native';
import { utf8ByteLength } from '@/lib/utf8-utils';

/**
 * Dev-only artifact mirror fixture: `kiloapp:///dev/artifact-mirror-fixture/seed`
 * writes a mirror into the container the phone's file browser reads, and
 * `.../release` clears it again. The only entry point is `+native-intent.tsx`,
 * behind `__DEV__`.
 *
 * It exists because the mirror is otherwise only populated by a signed-in
 * crawl of stored session history against a real backend, while the reader that
 * matters is a separate process: the iOS File Provider extension, reached from
 * the Files app. Seeding the container lets that walkthrough run without a
 * backend, and it exercises the writer's own naming and the extension's
 * resolution of the strings it finds.
 *
 * Two sessions, because the mirror legitimately carries two shapes:
 *
 * - `crawl` — what the app writes today: names through
 *   `safeArtifactDisplayName` + `uniqueArtifactDisplayNames`, so duplicates
 *   arrive already numbered and nothing needs sanitizing.
 * - `raw` — what an older or stale index can still hold: repeats, path
 *   separators, control characters, empty names and over-long names, which is
 *   exactly what the extension sanitizes and deduplicates before a name becomes
 *   a filename.
 *
 * The bytes are written where the sync engine puts them
 * (`sessions/<sessionId>/<fileId>`, the opaque id, never the display name), and
 * every index entry's `size` is derived from the bytes written, so the item the
 * browser shows and the file it opens agree on one file.
 */

type FixtureArtifact = { body: string; id: string; mime: string; name: string };

type FixtureSession = {
  artifacts: FixtureArtifact[];
  id: string;
  /** `crawl` writes the app's current output; `raw` writes a stale index. */
  naming: 'crawl' | 'raw';
  title: string;
  updatedAt: string;
};

const FIXTURE_WRITTEN_AT = '2026-01-02T03:04:05.000Z';

const FIXTURE_SESSIONS: FixtureSession[] = [
  {
    id: 'sess_fixture_artifacts',
    title: 'Fixture artifacts',
    updatedAt: FIXTURE_WRITTEN_AT,
    naming: 'crawl',
    artifacts: [
      {
        id: 'file_quarterly_a',
        name: 'Quarterly report.csv',
        mime: 'text/csv',
        body: 'quarter,units\nQ1,42\n',
      },
      {
        id: 'file_quarterly_b',
        name: 'Quarterly report.csv',
        mime: 'text/csv',
        body: 'quarter,units\nQ2,7\n',
      },
      {
        id: 'file_quarterly_c',
        name: 'Quarterly report.csv',
        mime: 'text/csv',
        body: 'quarter,units\nQ3,19\n',
      },
      {
        id: 'file_screenshot',
        name: 'screenshot.png',
        mime: 'image/png',
        body: 'not a png, but the browser only opens it\n',
      },
      {
        id: 'file_tarball',
        name: 'archive.tar.gz',
        mime: 'application/gzip',
        body: 'binary placeholder\n',
      },
      {
        id: 'file_resume',
        name: 'résumé.pdf',
        mime: 'application/pdf',
        body: 'resume placeholder\n',
      },
      { id: 'file_env', name: '.env', mime: 'text/plain', body: 'KILO_FIXTURE=1\n' },
      {
        id: 'file_long',
        name: `${'session notes '.repeat(20)}.txt`,
        mime: 'text/plain',
        body: 'a name far past the bound, so the extension keeps the extension\n',
      },
    ],
  },
  {
    id: 'sess_fixture_stale_index',
    title: 'Fixture stale index',
    updatedAt: '2026-01-01T00:00:00.000Z',
    naming: 'raw',
    artifacts: [
      {
        id: 'raw_path',
        name: '../../etc/passwd',
        mime: 'text/plain',
        body: 'passwd placeholder\n',
      },
      {
        id: 'raw_nested',
        name: 'reports/2026/summary.md',
        mime: 'text/markdown',
        body: '# summary\n',
      },
      { id: 'raw_dup_a', name: 'report.csv', mime: 'text/csv', body: 'a,b\n1,2\n' },
      { id: 'raw_dup_b', name: 'report.csv', mime: 'text/csv', body: 'c,d\n3,4\n' },
      { id: 'raw_dotfile', name: '.bashrc', mime: 'text/plain', body: 'export KILO_FIXTURE=1\n' },
      {
        id: 'raw_trailing_dot',
        name: 'trailing.',
        mime: 'text/plain',
        body: 'trailing dot placeholder\n',
      },
      { id: 'raw_empty', name: '', mime: 'text/csv', body: 'unnamed artifact\n' },
      {
        id: 'raw_control',
        name: 'bell\u0007name.txt',
        mime: 'text/plain',
        body: 'control character placeholder\n',
      },
      {
        id: 'raw_long',
        name: `${'x'.repeat(250)}.txt`,
        mime: 'text/plain',
        body: 'over-long name placeholder\n',
      },
      {
        id: 'raw_unicode',
        name: 'résumé (1).pdf',
        mime: 'application/pdf',
        body: 'unicode placeholder\n',
      },
    ],
  },
];

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[artifact-mirror-fixture] ${message}`);
}

function sessionFiles(session: FixtureSession): ArtifactMirrorFile[] {
  const files = session.artifacts.map(artifact => ({
    id: artifact.id,
    name: artifact.name,
    mime: artifact.mime,
    size: utf8ByteLength(artifact.body),
  }));
  if (session.naming === 'raw') {
    return files;
  }
  return uniqueArtifactDisplayNames(
    files.map(file => ({
      id: file.id,
      name: safeArtifactDisplayName(file),
      mime: file.mime,
      size: file.size,
    }))
  );
}

function sessionEntry(session: FixtureSession): ArtifactMirrorSession {
  return {
    id: session.id,
    title: safeArtifactSessionName({ id: session.id, title: session.title }),
    updatedAt: session.updatedAt,
    files: sessionFiles(session),
  };
}

/** The index the fixture writes, derived from the same artifacts as the bytes. */
export function artifactMirrorFixtureManifest(): ArtifactMirrorManifest {
  return {
    version: ARTIFACT_MIRROR_MANIFEST_VERSION,
    updatedAt: FIXTURE_WRITTEN_AT,
    sessions: FIXTURE_SESSIONS.map(session => sessionEntry(session)),
  };
}

function writeSessionBytes(session: FixtureSession): void {
  const directory = mirrorSessionDir(session.id);
  if (directory === null) {
    // No browsable container on this platform or build: nothing to seed.
    return;
  }
  directory.create({ idempotent: true, intermediates: true });
  for (const artifact of session.artifacts) {
    new File(directory, artifact.id).writeSync(artifact.body);
  }
}

/**
 * Write the fixture mirror and make it visible: the bytes first, then the index
 * through the writer the app uses (which writes it last, so a reader never sees
 * an index for files that are not there), then the domain and the root signal
 * the extension needs to re-enumerate.
 */
export function seedArtifactMirrorFixture(): void {
  for (const session of FIXTURE_SESSIONS) {
    writeSessionBytes(session);
  }
  applyArtifactSnapshot(artifactMirrorFixtureManifest());
  registerArtifactsProviderDomain();
  notifyArtifactsChanged();
  log('seeded');
}

/** Drop the fixture mirror so the location goes back to empty. */
export function releaseArtifactMirrorFixture(): void {
  clearArtifactMirror();
  notifyArtifactsChanged();
  log('released');
}

const FIXTURE_PATH = /(?:^|\/)dev\/artifact-mirror-fixture\/([\w-]+)\/?(?:[?#].*)?$/;
const SEED = 'seed';
const RELEASE = 'release';

/**
 * Handle a fixture link. True when the path is a fixture link (handled, even
 * when the name is unknown), so the caller returns falsy and nothing navigates.
 */
export function handleArtifactMirrorFixturePath(path: string): boolean {
  const name = FIXTURE_PATH.exec(path)?.[1];
  if (name === undefined) {
    return false;
  }
  if (name === SEED) {
    seedArtifactMirrorFixture();
  } else if (name === RELEASE) {
    releaseArtifactMirrorFixture();
  } else {
    log(`unknown fixture ${name}`);
  }
  return true;
}
