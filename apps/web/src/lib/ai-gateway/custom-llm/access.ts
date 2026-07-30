import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { BlockList, isIP } from 'node:net';

function isIpAllowed(clientIp: string, ipAllowList: string[]): boolean {
  const clientIpVersion = isIP(clientIp);
  if (clientIpVersion === 0) {
    return false;
  }

  const blockList = new BlockList();
  for (const allowedIp of ipAllowList) {
    const allowedIpVersion = isIP(allowedIp);
    if (allowedIpVersion === 0) {
      continue;
    }
    blockList.addAddress(allowedIp, allowedIpVersion === 4 ? 'ipv4' : 'ipv6');
  }

  return blockList.check(clientIp, clientIpVersion === 4 ? 'ipv4' : 'ipv6');
}

export function canAccessCustomLlm(
  definition: CustomLlmDefinition,
  organizationId: string,
  clientIp: string | null
): boolean {
  if (!definition.organization_ids.includes(organizationId)) {
    return false;
  }

  return definition.ip_allow_list === undefined
    ? true
    : clientIp !== null && isIpAllowed(clientIp, definition.ip_allow_list);
}
