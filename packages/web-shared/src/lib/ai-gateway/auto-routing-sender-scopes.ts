import type { ServiceTokenRequest } from '@kilocode/service-token-client';
import {
  STS_AUTO_ROUTING_ADMIN_READ,
  STS_AUTO_ROUTING_ADMIN_WRITE,
  STS_AUTO_ROUTING_BENCHMARK_ADMIN_READ,
  STS_AUTO_ROUTING_BENCHMARK_ADMIN_WRITE,
  STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ,
  STS_AUTO_ROUTING_DECIDE,
} from '@kilocode/sts-contracts';
import type { AutoRoutingSenderRoute } from './auto-routing-sender';

/**
 * Each route family's one scope: the receivers' `ROUTE_CONTRACTS`
 * (`services/auto-routing/src/auth.ts`, `services/auto-routing-benchmark/src/auth.ts`).
 */
export const AUTO_ROUTING_SENDER_SCOPES = {
  decide: STS_AUTO_ROUTING_DECIDE,
  adminRead: STS_AUTO_ROUTING_ADMIN_READ,
  adminWrite: STS_AUTO_ROUTING_ADMIN_WRITE,
  benchmarkRoutingTablesRead: STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ,
  benchmarkAdminRead: STS_AUTO_ROUTING_BENCHMARK_ADMIN_READ,
  benchmarkAdminWrite: STS_AUTO_ROUTING_BENCHMARK_ADMIN_WRITE,
} as const satisfies Record<AutoRoutingSenderRoute, ServiceTokenRequest>;
