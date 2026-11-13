import { type SshErrorCode } from '@kilocode/react-native-ssh';
import { Directory, File, Paths } from 'expo-file-system';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

import { nativeErrorCode, sshPackage } from '../native';

type TransferKind = 'upload' | 'download';

/**
 * A transfer ends in `done`, `failed` or `cancelled`; `active` is the only
 * state that still moves bytes. A failed transfer keeps the call that failed,
 * so Retry repeats exactly that call.
 */
type TransferStatus = 'active' | 'done' | 'failed' | 'cancelled';

export type SshTransfer = {
  readonly id: string;
  /** The session whose SFTP channel carries it. */
  readonly sessionId: string;
  readonly kind: TransferKind;
  /** The file name the row shows, without its directory. */
  readonly name: string;
  readonly remotePath: string;
  readonly bytes: number;
  /** The source's size, or null when it reported none. */
  readonly total: number | null;
  readonly status: TransferStatus;
  /** The core's failure category, or null for a local failure. */
  readonly code: SshErrorCode | null;
};

type TransferCall = Readonly<{
  sessionId: string;
  kind: TransferKind;
  name: string;
  remotePath: string;
  sftpId: string;
  /** The app-sandbox file an upload reads or a download writes. */
  localUri: string;
}>;

type Job = { controller: AbortController; call: TransferCall };

const CACHE_DIRECTORY = 'ssh-files';
const MAX_FINISHED = 20;

const transfers = new Map<string, SshTransfer>();
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
let snapshot: readonly SshTransfer[] = [];
let counter = 0;

function publish(): void {
  snapshot = [...transfers.values()].toReversed();
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Newest first, so the tray shows what just happened at its top. */
export function transfersSnapshot(): readonly SshTransfer[] {
  return snapshot;
}

/** The cache file an upload of `name` reads from or a download of it writes to. */
export function transferLocalUri(id: string, name: string): string {
  const directory = new Directory(Paths.cache, CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, getSafeCacheFilename({ id, filename: name })).uri;
}

export function startUpload(
  input: Readonly<{
    sessionId: string;
    sftpId: string;
    localUri: string;
    remotePath: string;
    name: string;
  }>
): string {
  const id = nextId();
  const call: TransferCall = { ...input, kind: 'upload', localUri: input.localUri };
  run(id, call);
  return id;
}

export function startDownload(
  input: Readonly<{ sessionId: string; sftpId: string; remotePath: string; name: string }>
): string {
  const id = nextId();
  const localUri = transferLocalUri(id, input.name);
  run(id, { ...input, kind: 'download', localUri });
  return id;
}

function nextId(): string {
  counter += 1;
  return `transfer-${Date.now()}-${counter}`;
}

function run(id: string, call: TransferCall): void {
  const controller = new AbortController();
  jobs.set(id, { controller, call });
  transfers.set(id, {
    id,
    sessionId: call.sessionId,
    kind: call.kind,
    name: call.name,
    remotePath: call.remotePath,
    bytes: 0,
    total: null,
    status: 'active',
    code: null,
  });
  publish();
  void perform(id, call, controller);
}

async function perform(id: string, call: TransferCall, controller: AbortController): Promise<void> {
  try {
    const ssh = await sshPackage();
    const onProgress = (progress: { transferred: number; total: number | null }): void => {
      update(id, { bytes: progress.transferred, total: progress.total });
    };
    const options = { onProgress, signal: controller.signal };
    const localUri = call.localUri;
    if (call.kind === 'upload') {
      await ssh.upload(call.sftpId, localUri, call.remotePath, options);
    } else {
      removeStale(localUri);
      await ssh.download(call.sftpId, call.remotePath, localUri, options);
    }
    jobs.delete(id);
    update(id, {
      status: 'done',
      bytes: transfers.get(id)?.total ?? transfers.get(id)?.bytes ?? 0,
    });
  } catch (error) {
    jobs.delete(id);
    if (controller.signal.aborted) {
      update(id, { status: 'cancelled' });
      return;
    }
    update(id, { status: 'failed', code: errorCodeOf(error) });
  }
}

/** A retried download writes a file the failed attempt may have left partial. */
function removeStale(localUri: string): void {
  const file = new File(localUri);
  if (file.exists) {
    file.delete();
  }
}

function errorCodeOf(error: unknown): SshErrorCode | null {
  const code = nativeErrorCode(error);
  return code === null ? null : (code as SshErrorCode);
}

function update(id: string, patch: Partial<Omit<SshTransfer, 'id'>>): void {
  const current = transfers.get(id);
  if (current === undefined) {
    return;
  }
  transfers.set(id, { ...current, ...patch });
  prune();
  publish();
}

/** Finished rows are kept for review, up to a bound; active ones are never dropped. */
function prune(): void {
  const finished = [...transfers.values()].filter(transfer => transfer.status !== 'active');
  if (finished.length <= MAX_FINISHED) {
    return;
  }
  const oldest = finished.slice(0, finished.length - MAX_FINISHED);
  for (const transfer of oldest) {
    transfers.delete(transfer.id);
  }
}

/** Cancels the transfer and marks it cancelled: the core rejects with `Cancelled`. */
export function cancelTransfer(id: string): void {
  jobs.get(id)?.controller.abort();
}

/** Repeats the call that failed, in place, under the same row. */
export function retryTransfer(id: string): void {
  const previous = jobs.get(id)?.call;
  if (previous === undefined || transfers.get(id)?.status === 'active') {
    return;
  }
  run(id, previous);
}

export function clearFinishedTransfers(): void {
  let changed = false;
  for (const [id, transfer] of transfers) {
    if (transfer.status !== 'active') {
      transfers.delete(id);
      changed = true;
    }
  }
  if (changed) {
    publish();
  }
}

/** The transfers one session's browser shows, newest first. */
export function transfersForSession(
  all: readonly SshTransfer[],
  sessionId: string
): readonly SshTransfer[] {
  return all.filter(transfer => transfer.sessionId === sessionId);
}

/**
 * Dev fixtures only: rows the design gate photographs without a server behind
 * them. Never called from app code.
 */
export function insertFixtureTransfers(sessionId: string): void {
  const fixture = [
    {
      name: 'backup.tar.gz',
      kind: 'download' as const,
      status: 'active' as const,
      bytes: 42_000_000,
      total: 120_000_000,
      code: null,
    },
    {
      name: 'deploy.log',
      kind: 'upload' as const,
      status: 'failed' as const,
      bytes: 0,
      total: null,
      code: 'PermissionDenied' as const,
    },
    {
      name: 'notes.txt',
      kind: 'download' as const,
      status: 'done' as const,
      bytes: 918,
      total: 918,
      code: null,
    },
  ];
  for (const [index, row] of fixture.entries()) {
    const id = `fixture-transfer-${index}`;
    transfers.set(id, {
      id,
      sessionId,
      kind: row.kind,
      name: row.name,
      remotePath: `/home/user/${row.name}`,
      bytes: row.bytes,
      total: row.total,
      status: row.status,
      code: row.code,
    });
  }
  publish();
}

/** The cache file a finished download landed at, or null when none did. */
export function downloadedFileUri(transfer: SshTransfer): string | null {
  if (transfer.kind !== 'download' || transfer.status !== 'done') {
    return null;
  }
  return transferLocalUri(transfer.id, transfer.name);
}
