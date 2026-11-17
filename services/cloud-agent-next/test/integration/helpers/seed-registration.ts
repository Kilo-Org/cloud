import { runInDurableObject } from 'cloudflare:test';
import { markHistoryHydrated } from '../../../src/control-plane/session/history-hydration.js';
import type {
  ControlPlaneSessionRegistration,
  SandboxSessionV2,
} from '../../../src/control-plane/session/session-do.js';

/**
 * Seeds a stored registration for tests that need a session with a
 * registration but no grouped metadata, which the product RPCs no longer
 * produce: they always write both.
 */
export async function seedRegistration(
  stub: DurableObjectStub<SandboxSessionV2>,
  registration: ControlPlaneSessionRegistration
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    markHistoryHydrated(state.storage);
    await state.storage.put('control_plane_session', registration);
    Object.assign(instance, { registration });
  });
}
