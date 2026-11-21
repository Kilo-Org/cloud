import { parseControlPlaneCredential } from '../shared/control-plane-credential.js';
import { withDORetry } from '../utils/do-retry.js';
import { getSandboxControlStub } from './stub.js';
import { builderNetworkSecretEnvironmentId } from '../network-secrets/builder-scope.js';

export async function resolveOutboundCredential(
  env: Cloudflare.Env,
  input: { credential: string; outboundContainerId: string; url: string; method: string }
): Promise<unknown> {
  const parsed = parseControlPlaneCredential(input.credential);
  if (!parsed) return null;
  const builderEnvironmentId =
    parsed.purpose === 'secret' ? builderNetworkSecretEnvironmentId(parsed.sandboxId) : null;
  const sanitize = (error: unknown) =>
    Object.assign(new Error('Control-plane authorization unavailable'), {
      retryable: error instanceof Error && Reflect.get(error, 'retryable') === true,
    });
  if (builderEnvironmentId !== null) {
    return withDORetry(
      () => env.ENVIRONMENT_BUILD.getByName(builderEnvironmentId),
      async stub => {
        try {
          return await stub.resolveCredential(input);
        } catch (error) {
          throw sanitize(error);
        }
      },
      'resolveControlPlaneCredential'
    );
  }
  if (!env.SANDBOX_CONTROL) return null;
  return withDORetry(
    () => {
      try {
        return getSandboxControlStub(env, parsed.sandboxId);
      } catch (error) {
        throw sanitize(error);
      }
    },
    async stub => {
      try {
        return await stub.resolveCredential(input);
      } catch (error) {
        throw sanitize(error);
      }
    },
    'resolveControlPlaneCredential'
  );
}
