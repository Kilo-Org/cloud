import {
  type AuthorizationServerMetadata,
  UTS_AUTHORIZE_PATH,
  UTS_DEVICE_AUTHORIZATION_PATH,
  UTS_DPOP_ALGORITHMS,
  UTS_GRANT_TYPES,
  UTS_INTROSPECT_PATH,
  UTS_REVOKE_PATH,
  UTS_TOKEN_PATH,
} from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';
import type { OAuthService } from '../oauth/routes';

/**
 * RFC 8414 metadata for the issuer. It lists only what answers: the issuer and the key set on the
 * feed Worker always; the authorization, token, revocation and introspection endpoints once the
 * identity store is bound; the device grant (RFC 8628 section 4) once its user-code secret is
 * set; `private_key_jwt` (EdDSA) once `kilo-web`'s key set is valid (`webClientReady`); and the
 * RFC 8693 token exchange where the broker exchange is wired or `kilo-web`'s legacy bridge is on.
 * Without `grant_types_supported`, a reader would assume `authorization_code` and `implicit`.
 */
export function authorizationServerMetadata(
  config: UtsConfig,
  oauth: OAuthService,
  webClientReady: boolean
): AuthorizationServerMetadata {
  const base = {
    issuer: config.endpoints.issuer,
    jwks_uri: config.endpoints.jwksUri,
  };
  if (oauth.kind === 'unprovisioned') {
    return { ...base, response_types_supported: [], grant_types_supported: [] };
  }
  const { issuer } = config.endpoints;
  const device = oauth.deps.device.status === 'served';
  // `kilo-web` answers only where its key set is valid; its legacy bridge only where it is on too.
  const bridge = webClientReady && oauth.deps.web.bridge.status === 'on';
  return {
    ...base,
    authorization_endpoint: `${issuer}${UTS_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${UTS_TOKEN_PATH}`,
    revocation_endpoint: `${issuer}${UTS_REVOKE_PATH}`,
    introspection_endpoint: `${issuer}${UTS_INTROSPECT_PATH}`,
    ...(device
      ? { device_authorization_endpoint: `${issuer}${UTS_DEVICE_AUTHORIZATION_PATH}` }
      : {}),
    response_types_supported: ['code'],
    grant_types_supported: [
      UTS_GRANT_TYPES.authorizationCode,
      UTS_GRANT_TYPES.refreshToken,
      ...(device ? [UTS_GRANT_TYPES.deviceCode] : []),
      ...(oauth.deps.exchange === null && !bridge ? [] : [UTS_GRANT_TYPES.tokenExchange]),
    ],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: webClientReady ? ['none', 'private_key_jwt'] : ['none'],
    ...(webClientReady ? { token_endpoint_auth_signing_alg_values_supported: ['EdDSA'] } : {}),
    revocation_endpoint_auth_methods_supported: ['none'],
    introspection_endpoint_auth_methods_supported: ['none'],
    dpop_signing_alg_values_supported: [...UTS_DPOP_ALGORITHMS],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
