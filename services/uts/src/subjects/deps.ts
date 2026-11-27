import { type WaitUntil, withIdentityStore } from '../db/client';
import type { Env, UtsConfig } from '../env';
import { identityStoreBinding } from '../grants/binding';
import { feedPublisher } from '../revocation/publish';
import type { SubjectDeps } from './operations';
import { identityStoreSubjects } from './store';

/**
 * The subject statements over the identity store's primary config, and the feed publisher. Null
 * until the environment binds its identity store, so every caller answers `unavailable`.
 */
export function subjectDeps(env: Env, context: WaitUntil, config: UtsConfig): SubjectDeps | null {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return null;
  return {
    environment: config.environment,
    rpId: config.relyingParty.rpId,
    subjects: work =>
      withIdentityStore(binding.connectionString, context, store =>
        work(identityStoreSubjects(store))
      ),
    publish: feedPublisher(env, config, context),
  };
}
