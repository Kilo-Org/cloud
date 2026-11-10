import {
  type NativeConversation,
  type NativePendingRequests,
  type NativeSessionConnection,
  type NativeSessionState,
  type NativeSessionSummary,
  readNativeConversation,
} from '@kilocode/cloud-agent-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';
import { sendNativePrompt } from './projections';
import { nativeError, type NativeRemoteClient } from './use-native-inventory';

export type NativeRemoteSession = {
  state: NativeSessionState | undefined;
  conversation: NativeConversation | undefined;
  busy: boolean;
  error: string;
  commandID: string;
  pending: NativePendingRequests;
  canControl: boolean;
  run: (operation: (connection: NativeSessionConnection) => Promise<string>) => Promise<boolean>;
  send: (text: string, queue: boolean) => Promise<boolean>;
  clear: () => void;
};

export function useNativeSession(client: NativeRemoteClient, session?: NativeSessionSummary) {
  const sessionID = session?.sessionID;
  const organizationID = session?.tenant.type === 'organization' ? session.tenant.id : undefined;
  const [state, setState] = useState<NativeSessionState>();
  const [busy, setBusy] = useState(false);
  const [errorMessage, setError] = useState('');
  const [commandID, setCommandID] = useState('');
  const [owner, setOwner] = useState({ client, sessionID, organizationID });
  if (
    owner.client !== client ||
    owner.sessionID !== sessionID ||
    owner.organizationID !== organizationID
  ) {
    setOwner({ client, sessionID, organizationID });
    setState(undefined);
    setBusy(false);
    setError('');
    setCommandID('');
  }
  const connectionRef = useRef<NativeSessionConnection | null>(null);
  const inFlight = useRef<NativeSessionConnection | null>(null);
  const scope = useRef({ client, sessionID, organizationID });
  scope.current = { client, sessionID, organizationID };

  useEffect(() => {
    let active = true;
    const matches = () =>
      active &&
      scope.current.client === client &&
      scope.current.sessionID === sessionID &&
      scope.current.organizationID === organizationID;
    const connection = sessionID
      ? client.connectSession(
          sessionID,
          value => {
            if (matches()) {
              setState(value);
            }
          },
          organizationID
        )
      : null;
    connectionRef.current = connection;
    return () => {
      active = false;
      connectionRef.current = null;
      connection?.close();
    };
  }, [client, sessionID, organizationID]);

  async function run(operation: (connection: NativeSessionConnection) => Promise<string>) {
    const connection = connectionRef.current;
    const started = scope.current;
    if (!connection || inFlight.current === connection) {
      return false;
    }
    const matches = () =>
      connectionRef.current === connection &&
      scope.current.client === started.client &&
      scope.current.sessionID === started.sessionID &&
      scope.current.organizationID === started.organizationID;
    inFlight.current = connection;
    setBusy(true);
    setError('');
    try {
      const id = await operation(connection);
      if (!matches()) {
        return false;
      }
      setCommandID(id);
      return true;
    } catch (error) {
      if (matches()) {
        const message = nativeError(error);
        setError(message);
        toast.error(message);
      }
      return false;
    } finally {
      if (inFlight.current === connection) {
        inFlight.current = null;
      }
      if (matches()) {
        setBusy(false);
      }
    }
  }
  const conversation = useMemo(() => (state ? readNativeConversation(state) : undefined), [state]);
  const pending = conversation?.pending ?? { permissions: [], questions: [] };

  return {
    state,
    conversation,
    busy,
    error: errorMessage,
    commandID,
    pending,
    canControl: state?.connection === 'connected' && state.runnerConnected && !busy,
    run,
    send: (text: string, queue: boolean) =>
      run(connection => sendNativePrompt(connection, text, queue)),
    // SDK clear hides transcript messages only; pending remote.state remains intact.
    clear: () => connectionRef.current?.clear(),
  };
}
