import { ContainerUsageAdmissionError } from '@kilocode/container-usage';

/** The rejection the usage meter returns when a start would exceed a concurrent-container cap. */
export function containerLimitError(
  account: 'user' | 'organization' = 'user',
  limit = 20
): ContainerUsageAdmissionError {
  return new ContainerUsageAdmissionError(
    'container_limit_reached',
    `container_limit_reached: The ${account} has reached its limit of ${limit} concurrent containers. Stop an existing container before starting another.`
  );
}
