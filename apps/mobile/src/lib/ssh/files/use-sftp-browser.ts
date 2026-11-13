import { type SftpEntry } from '../../../../modules/kilo-ssh/src';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type Cancellation } from '../cancellation';
import { nativeErrorCode, sshPackage } from '../native';
import { resolveHomeDirectory } from './paths';

export type SftpBrowserPhase =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly code: string };

export type SftpBrowser = Readonly<{
  phase: SftpBrowserPhase;
  /** The directory on screen; null until the home directory resolved. */
  path: string | null;
  entries: readonly SftpEntry[];
  /** A pull-to-refresh or a navigation is waiting on the server. */
  loading: boolean;
  refreshing: boolean;
  /** The SFTP channel, for the transfer store; null until it opened. */
  sftpId: string | null;
  open: (path: string) => void;
  refresh: () => void;
}>;

/**
 * An SFTP channel on the session's connection, and the directory it shows.
 *
 * The channel lives on the connection, not on this screen: a session that
 * reconnects gets a new native session id, so the browser opens a fresh channel
 * and resolves the home directory again.
 */
export function useSftpBrowser(connectionId: string | null): SftpBrowser {
  const [phase, setPhase] = useState<SftpBrowserPhase>({ kind: 'waiting' });
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sftpRef = useRef<string | null>(null);
  const [sftpId, setSftpId] = useState<string | null>(null);
  // Every list carries the request it belongs to, so an answer for a directory
  // the person already left cannot replace the one on screen.
  const requestRef = useRef(0);

  const list = useCallback(async (channel: string, target: string, mode: 'open' | 'refresh') => {
    requestRef.current += 1;
    const request = requestRef.current;
    if (mode === 'refresh') {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setPhase({ kind: 'ready' });
    try {
      const ssh = await sshPackage();
      const listed = await ssh.listDirectory(channel, target);
      if (requestRef.current !== request) {
        return;
      }
      setEntries(listed);
      setPath(target);
    } catch (error) {
      if (requestRef.current !== request) {
        return;
      }
      setPhase({ kind: 'error', code: nativeErrorCode(error) ?? 'Protocol' });
    } finally {
      if (requestRef.current === request) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (connectionId === null) {
      return undefined;
    }
    const opening: Cancellation = { cancelled: false };
    setPhase({ kind: 'opening' });
    setEntries([]);
    setPath(null);
    void (async () => {
      try {
        const ssh = await sshPackage();
        const channel = await ssh.openSftp(connectionId);
        const home = await resolveHomeDirectory(channel, (sftp, path) =>
          ssh.resolvePath(sftp, path)
        );
        if (opening.cancelled) {
          await closeQuietly(ssh, channel);
          return;
        }
        sftpRef.current = channel;
        setSftpId(channel);
        await list(channel, home, 'open');
      } catch (error) {
        if (!opening.cancelled) {
          setPhase({ kind: 'error', code: nativeErrorCode(error) ?? 'unavailable' });
        }
      }
    })();
    return () => {
      opening.cancelled = true;
      requestRef.current += 1;
      const channel = sftpRef.current;
      sftpRef.current = null;
      setSftpId(null);
      if (channel !== null) {
        void (async () => {
          try {
            await closeQuietly(await sshPackage(), channel);
          } catch {
            // A build without the module has no channel to close.
          }
        })();
      }
    };
  }, [connectionId, list]);

  const open = useCallback(
    (target: string) => {
      const channel = sftpRef.current;
      if (channel !== null) {
        void list(channel, target, 'open');
      }
    },
    [list]
  );

  const refresh = useCallback(() => {
    const channel = sftpRef.current;
    if (channel !== null && path !== null) {
      void list(channel, path, 'refresh');
    }
  }, [list, path]);

  return { phase, path, entries, loading, refreshing, sftpId, open, refresh };
}

/** Closes a channel whose connection may already be gone. */
async function closeQuietly(
  ssh: Awaited<ReturnType<typeof sshPackage>>,
  channel: string
): Promise<void> {
  try {
    await ssh.closeSftp(channel);
  } catch {
    // The connection the channel ran on is already gone.
  }
}
