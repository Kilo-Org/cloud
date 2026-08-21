import type { WrapperKiloClient } from './kilo-api';

export async function abortKiloSessionForShutdown({
  activeKiloSessionId,
  kiloClient,
}: {
  activeKiloSessionId: string | undefined;
  kiloClient: Pick<WrapperKiloClient, 'abortSession'> | undefined;
}): Promise<void> {
  if (activeKiloSessionId && kiloClient) {
    await kiloClient.abortSession({ sessionId: activeKiloSessionId }).catch(() => {});
  }
}
