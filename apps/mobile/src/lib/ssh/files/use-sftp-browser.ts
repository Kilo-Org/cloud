import { type SftpEntry } from '@kilocode/react-native-ssh';
import { useCallback, useEffect, useRef, useState } from 'react';

import { nativeErrorCode, sshPackage } from '../native';

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
    let cancelled = false;
    setPhase({ kind: 'opening' });
    setEntries([]);
    setPath(null);
    void (async () => {
      try {
        const ssh = await sshPackage();
        const channel = await ssh.openSftp(connectionId);
        if (cancelled) {
          await ssh.closeSftp(channel).catch(() => undefined);
          return;
        }
        sftpRef.current = channel;
        setSftpId(channel);
        const home = await ssh.resolvePath(channel, '~');
        if (cancelled) {
          return;
        }
        await list(channel, home, 'open');
      } catch (error) {
        if (!cancelled) {
          setPhase({ kind: 'error', code: nativeErrorCode(error) ?? 'unavailable' });
        }
      }
    })();
    return () => {
      cancelled = true;
      requestRef.current += 1;
      const channel = sftpRef.current;
      sftpRef.current = null;
      setSftpId(null);
      if (channel !== null) {
        void sshPackage()
          .then(ssh => ssh.closeSftp(channel))
          .catch(() => undefined);
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
