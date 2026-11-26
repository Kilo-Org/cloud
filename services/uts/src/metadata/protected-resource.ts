import {
  UTS_BOT_KEYS_MANAGE_SCOPE,
  UTS_PATS_MANAGE_SCOPE,
  UTS_PROBE_READ_SCOPE,
} from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';

/**
 * RFC 9728 protected-resource metadata for the routes the mint Worker serves as a resource: the
 * account API and the PAT probe route. The resource is the issuer origin, and UTS is its own
 * authorization server. It lists the scopes of the routes that answer.
 */
export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ['header'];
  resource_name: string;
};

export function protectedResourceMetadata(
  config: UtsConfig,
  served: { account: boolean; probe: boolean }
): ProtectedResourceMetadata {
  return {
    resource: config.endpoints.issuer,
    authorization_servers: [config.endpoints.issuer],
    scopes_supported: [
      ...(served.account ? [UTS_PATS_MANAGE_SCOPE, UTS_BOT_KEYS_MANAGE_SCOPE] : []),
      ...(served.probe ? [UTS_PROBE_READ_SCOPE] : []),
    ],
    bearer_methods_supported: ['header'],
    resource_name: 'Kilo account API',
  };
}
