import type { BillingActor, BillingSubject } from './contracts';

export const USER_CONTAINER_LIMIT = 20;
export const LOW_BALANCE_CONTAINER_LIMIT = 3;
export const FUNDED_CONTAINER_MINIMUM_MICRODOLLARS = 3_000_000;
export const ORGANIZATION_CONTAINER_LIMIT = 50;

export type ContainerConcurrencySubject = BillingSubject;
export type ContainerCapacityCheckpoint = 'control-plane-create' | 'sandbox-start';

export type ContainerCapacityRequest = {
  subject: ContainerConcurrencySubject;
  actor: BillingActor;
  instanceId: string;
  checkpoint: ContainerCapacityCheckpoint;
  billingOrigin?: string;
};

export type ContainerCapacityCheck = {
  subject: ContainerConcurrencySubject;
  live: number;
  limit: number;
};

export type ContainerCapacityScope = {
  type: 'actor' | 'subject';
  subject: ContainerConcurrencySubject;
};

export class ContainerConcurrencyLimitError extends Error {
  readonly code = 'container_limit_reached';

  constructor(
    readonly accountType: 'personal' | 'organization',
    readonly limit: number
  ) {
    super(
      `container_limit_reached: The ${accountType === 'personal' ? 'user' : 'organization'} has reached its limit of ${limit} concurrent containers. Stop an existing container before starting another.`
    );
    this.name = 'ContainerConcurrencyLimitError';
  }
}

export class ContainerCapacityUnavailableError extends Error {
  readonly code = 'container_capacity_unavailable';

  constructor() {
    super(
      'container_capacity_unavailable: Cannot verify container capacity or account balance. Try again shortly.'
    );
    this.name = 'ContainerCapacityUnavailableError';
  }
}

export function getContainerCapacityFailureReason(
  error: unknown
): 'container_limit_reached' | 'billing_unavailable' | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'container_limit_reached') return 'container_limit_reached';
    if (error.code === 'container_capacity_unavailable') return 'billing_unavailable';
  }
  const message =
    typeof error === 'string'
      ? error
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : '';
  if (message.includes('container_limit_reached:')) return 'container_limit_reached';
  if (message.includes('container_capacity_unavailable:')) return 'billing_unavailable';
  return undefined;
}

export function isContainerConcurrencyExempt(request: ContainerCapacityRequest): boolean {
  return request.billingOrigin === 'code-review' || request.instanceId.startsWith('crv-');
}

export function getContainerCapacityScopes(
  request: ContainerCapacityRequest
): ContainerCapacityScope[] {
  const scopes: ContainerCapacityScope[] = [];
  if (request.actor.type === 'user') {
    scopes.push({ type: 'actor', subject: { type: 'user', id: request.actor.id } });
  }
  if (request.subject.type === 'org' || request.actor.type === 'bot') {
    scopes.push({ type: 'subject', subject: request.subject });
  }
  return scopes;
}

export function getContainerCapacityLimit(
  scope: ContainerCapacityScope,
  balanceMicrodollars: number
): number {
  if (scope.type === 'actor') {
    return balanceMicrodollars < FUNDED_CONTAINER_MINIMUM_MICRODOLLARS
      ? LOW_BALANCE_CONTAINER_LIMIT
      : USER_CONTAINER_LIMIT;
  }
  return scope.subject.type === 'org' ? ORGANIZATION_CONTAINER_LIMIT : USER_CONTAINER_LIMIT;
}
