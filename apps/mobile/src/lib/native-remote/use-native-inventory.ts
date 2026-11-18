import {
  type NativePresenceConnection,
  type NativePresenceState,
  type NativeSessionSummary,
  type NativeSyncClient,
} from '@kilocode/cloud-agent-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner-native';
import { i18n } from '@/i18n';
import { createdSession } from './projections';

export function nativeError(cause: unknown) {
  return cause instanceof Error ? cause.message : i18n.t('nativeRemote.failed');
}

export type NativeRemoteClient = Pick<
  NativeSyncClient,
  'listSessions' | 'connectPresence' | 'connectSession'
>;

export type NativeInventory = {
  presence: NativePresenceState;
  sessions: NativeSessionSummary[];
  cursor: string | null;
  loading: boolean;
  creating: boolean;
  error: string;
  load: (cursor?: string) => Promise<void>;
  create: (
    instance: NativePresenceState['instances'][number],
    directory: string
  ) => Promise<NativeSessionSummary | undefined>;
};

export function useNativeInventory(client: NativeRemoteClient, organizationID?: string) {
  const [presence, setPresence] = useState<NativePresenceState>({
    connection: 'connecting',
    instances: [],
  });
  const [sessions, setSessions] = useState<NativeSessionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setError] = useState('');
  const owner = useRef(client);
  owner.current = client;
  const lifetime = useRef(0);
  const request = useRef(0);
  const presenceRef = useRef<NativePresenceConnection | null>(null);

  const load = useCallback(
    async (next?: string) => {
      const generation = lifetime.current;
      request.current += 1;
      const requestID = request.current;
      setLoading(true);
      setError('');
      try {
        const page = await client.listSessions(next);
        if (
          owner.current !== client ||
          lifetime.current !== generation ||
          request.current !== requestID
        ) {
          return;
        }
        setSessions(previous => {
          if (!next) {
            return page.items;
          }
          const combined = new Map(previous.map(item => [item.sessionID, item]));
          for (const item of page.items) {
            combined.set(item.sessionID, item);
          }
          return [...combined.values()];
        });
        setCursor(page.cursor);
      } catch (error) {
        if (
          owner.current === client &&
          lifetime.current === generation &&
          request.current === requestID
        ) {
          setError(nativeError(error));
        }
      } finally {
        if (
          owner.current === client &&
          lifetime.current === generation &&
          request.current === requestID
        ) {
          setLoading(false);
        }
      }
    },
    [client]
  );

  useEffect(() => {
    lifetime.current += 1;
    const generation = lifetime.current;
    setPresence({ connection: 'connecting', instances: [] });
    setSessions([]);
    setCursor(null);
    setCreating(false);
    void load();
    const connection = client.connectPresence(state => {
      if (owner.current !== client || lifetime.current !== generation) {
        return;
      }
      setPresence(state);
      // Session liveness is creator-index metadata, not inferred from host names.
      if (state.connection === 'connected') {
        void load();
      }
    }, organizationID);
    presenceRef.current = connection;
    return () => {
      lifetime.current = generation + 1;
      presenceRef.current = null;
      connection.close();
    };
  }, [client, load, organizationID]);

  async function create(instance: NativePresenceState['instances'][number], directory: string) {
    const generation = lifetime.current;
    const connection = presenceRef.current;
    if (!connection || !instance.online || creating) {
      return undefined;
    }
    setCreating(true);
    setError('');
    try {
      const launchDirectory = directory.trim();
      const reply = await connection.command(
        instance.instanceID,
        'create_session',
        launchDirectory ? { directory: launchDirectory } : {}
      );
      if (
        owner.current !== client ||
        lifetime.current !== generation ||
        presenceRef.current !== connection
      ) {
        return undefined;
      }
      if (reply.status === 'unknown') {
        throw new Error(i18n.t('nativeRemote.creationUnknown'));
      }
      const sessionID = createdSession(reply.body);
      void load();
      return {
        sessionID,
        tenant: instance.tenant,
        live: true,
        createdAt: Date.now(),
      } satisfies NativeSessionSummary;
    } catch (error) {
      if (owner.current === client && lifetime.current === generation) {
        const message = nativeError(error);
        setError(message);
        toast.error(message);
      }
    } finally {
      if (owner.current === client && lifetime.current === generation) {
        setCreating(false);
      }
    }
    return undefined;
  }

  return { presence, sessions, cursor, loading, creating, error: errorMessage, load, create };
}
