const MEBIBYTE_BYTES = 1024 ** 2;
const MEGABYTE_BYTES = 1_000_000;

export type ContainerCapacity = {
  vcpu: number;
  memoryBytes: number;
  diskBytes: number;
};

export function containerCapacityForService(service: string): ContainerCapacity | null {
  switch (service) {
    case 'gastown':
    case 'cloud-agent-next-sandbox':
    case 'cloud-agent-next-sandbox-containment':
      return {
        vcpu: 4,
        memoryBytes: 12_288 * MEBIBYTE_BYTES,
        diskBytes: 20_000 * MEGABYTE_BYTES,
      };
    case 'cloud-agent-next-sandbox-small':
    case 'cloud-agent-next-sandbox-dind':
    case 'cloud-agent-next-sandbox-small-containment':
      return { vcpu: 2, memoryBytes: 6_144 * MEBIBYTE_BYTES, diskBytes: 10_000 * MEGABYTE_BYTES };
    case 'cloud-agent-next-sandbox-code-review':
    case 'cloud-agent-next-sandbox-code-review-containment':
      return { vcpu: 1, memoryBytes: 4_096 * MEBIBYTE_BYTES, diskBytes: 8_000 * MEGABYTE_BYTES };
    default:
      return null;
  }
}

export function sharedContainerCapacity(services: Set<string>): ContainerCapacity | null {
  let shared: ContainerCapacity | null = null;
  for (const service of services) {
    const capacity = containerCapacityForService(service);
    if (!capacity) return null;
    if (
      shared &&
      (shared.vcpu !== capacity.vcpu ||
        shared.memoryBytes !== capacity.memoryBytes ||
        shared.diskBytes !== capacity.diskBytes)
    ) {
      return null;
    }
    shared = capacity;
  }
  return shared;
}
