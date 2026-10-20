export const CODE_REVIEW_CONTAINERS_INSTANCE = 'code-review' as const;

export type ContainerInstanceSize =
  | 'lite'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4'
  | typeof CODE_REVIEW_CONTAINERS_INSTANCE;

export type ContainerInstanceResources = {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
};

/**
 * The Cloudflare Sandbox code-review class is 1 vCPU / 4 GiB / 8 GB. Cloudflare
 * custom instance types allow at most 2 GB disk per GiB of memory, so 4 GiB
 * cannot pair with the containment class's 20 GB disk.
 */
export const CODE_REVIEW_CONTAINERS_RESOURCES: ContainerInstanceResources = {
  vcpu: 1,
  memoryMib: 4_096,
  diskMb: 8_000,
};

export function containerInstanceStartValue(
  instance: ContainerInstanceSize
):
  | Exclude<ContainerInstanceSize, typeof CODE_REVIEW_CONTAINERS_INSTANCE>
  | ContainerInstanceResources {
  return instance === CODE_REVIEW_CONTAINERS_INSTANCE ? CODE_REVIEW_CONTAINERS_RESOURCES : instance;
}
