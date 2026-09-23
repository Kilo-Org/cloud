import {
  ON_PREM_KILO_ROUTE_PREFIXES,
  parseCanonicalOnPremUrl,
} from '../../../src/shared/onprem-credential-protocol.js';
import type { SessionAttachPayload } from '../../../src/shared/sandbox-control-protocol.js';

type KiloTargets = NonNullable<SessionAttachPayload['kilo']>['targets'];

export function onPremKiloTargets(
  targets: KiloTargets,
  brokerUrl: string | undefined
): KiloTargets {
  if (brokerUrl === undefined) return targets;
  const broker = parseCanonicalOnPremUrl(brokerUrl);
  if (!broker || broker.protocol !== 'https:' || broker.pathname !== '/' || broker.search) {
    throw new Error('Invalid on-prem broker URL');
  }
  const rewrite = (key: keyof KiloTargets): string => {
    const target = parseCanonicalOnPremUrl(targets[key]);
    if (!target || target.search) throw new Error('Invalid on-prem Kilo target');
    return `${broker.origin}${ON_PREM_KILO_ROUTE_PREFIXES[key]}${target.pathname.replace(/\/+$/, '')}`;
  };
  return {
    backendBaseUrl: rewrite('backendBaseUrl'),
    providerBaseUrl: rewrite('providerBaseUrl'),
    sessionIngestBaseUrl: rewrite('sessionIngestBaseUrl'),
  };
}
