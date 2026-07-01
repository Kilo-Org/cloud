import 'server-only';
import { db } from '@/lib/drizzle';
import { createGatewayRepository } from './repository';
import { getGatewayAppConfig, type GatewayAppConfig } from './config';
import { createRouteService } from './route-service';
import { createAuditService } from './audit-service';
import { createOAuthClientService } from './oauth-client-service';
import { createOAuthGrantService } from './oauth-grant-service';
import { createGrantService } from './grant-service';
import { createProviderOAuthService } from './provider-oauth-service';
import { createAuthorizationService } from './authorization-service';
import { createTokenService } from './token-service';
import { createConfigService } from './config-service';
import { createDiscoveryService } from './discovery-service';
import { createAvailableService } from './available-service';
import { createNativeMcpAuthorizationService } from '@/lib/native-mcp/oauth/native-authorization-service';
import { createNativeMcpTokenService } from '@/lib/native-mcp/oauth/native-token-service';
import { createNativeMcpTokenVerifier } from '@/lib/native-mcp/oauth/native-token-verifier';

export function createGatewayServices(
  params: {
    config?: GatewayAppConfig;
    database?: typeof db;
    fetchImpl?: typeof fetch;
  } = {}
) {
  const config = params.config ?? getGatewayAppConfig();
  const repository = createGatewayRepository(params.database ?? db);
  const routeService = createRouteService({ repository, gatewayBaseUrl: config.gatewayBaseUrl });
  const auditService = createAuditService(repository);
  const oauthGrantService = createOAuthGrantService(repository);
  const clientService = createOAuthClientService({ repository, config, oauthGrantService });
  const grantService = createGrantService({ repository, config });
  const discoveryService = createDiscoveryService({ fetchImpl: params.fetchImpl });
  const providerOAuthService = createProviderOAuthService({
    repository,
    routeService,
    grantService,
    oauthGrantService,
    config,
    fetchImpl: params.fetchImpl,
  });
  const authorizationService = createAuthorizationService({
    repository,
    routeService,
    clientService,
    oauthGrantService,
    providerOAuthService,
    config,
  });
  const tokenService = createTokenService({
    repository,
    routeService,
    clientService,
    oauthGrantService,
    config,
  });
  const nativeMcpAuthorizationService = createNativeMcpAuthorizationService({
    database: params.database,
    clientService,
    config,
  });
  const nativeMcpTokenService = createNativeMcpTokenService({
    database: params.database,
    clientService,
    config,
  });
  const nativeMcpTokenVerifier = createNativeMcpTokenVerifier({
    database: params.database,
    config,
  });
  const configService = createConfigService({ repository, config, discoveryService });
  const availableService = createAvailableService(repository);

  return {
    config,
    repository,
    routeService,
    auditService,
    clientService,
    oauthGrantService,
    grantService,
    providerOAuthService,
    authorizationService,
    tokenService,
    nativeMcpAuthorizationService,
    nativeMcpTokenService,
    nativeMcpTokenVerifier,
    configService,
    discoveryService,
    availableService,
  };
}

export type GatewayServices = ReturnType<typeof createGatewayServices>;
