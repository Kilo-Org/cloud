import 'server-only';
import { db } from '@/lib/drizzle';
import { createGatewayRepository } from './repository';
import { getGatewayAppConfig, type GatewayAppConfig } from './config';
import { createRouteService } from './route-service';
import { createAuditService } from './audit-service';
import { createOAuthClientService } from './oauth-client-service';
import { createGrantService } from './grant-service';
import { createProviderOAuthService } from './provider-oauth-service';
import { createAuthorizationService } from './authorization-service';
import { createTokenService } from './token-service';
import { createConfigService } from './config-service';
import { createDiscoveryService } from './discovery-service';
import { createAvailableService } from './available-service';

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
  const clientService = createOAuthClientService({ repository, config });
  const grantService = createGrantService({ repository, config });
  const providerOAuthService = createProviderOAuthService({
    repository,
    routeService,
    grantService,
    config,
    fetchImpl: params.fetchImpl,
  });
  const authorizationService = createAuthorizationService({
    repository,
    routeService,
    clientService,
    providerOAuthService,
    config,
  });
  const tokenService = createTokenService({ repository, routeService, clientService, config });
  const discoveryService = createDiscoveryService({ fetchImpl: params.fetchImpl });
  const configService = createConfigService({ repository, config, discoveryService });
  const availableService = createAvailableService(repository);

  return {
    config,
    repository,
    routeService,
    auditService,
    clientService,
    grantService,
    providerOAuthService,
    authorizationService,
    tokenService,
    configService,
    discoveryService,
    availableService,
  };
}

export type GatewayServices = ReturnType<typeof createGatewayServices>;
