import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from '@kilocode/encryption';
import { z } from 'zod';
import {
  ON_PREM_ALLOCATION_REPLAY_WINDOW_MS,
  ON_PREM_CLOCK_SKEW_MS,
  ON_PREM_MAX_BATCH_SIZE,
  ON_PREM_PROTOCOL_VERSION,
  decodeOnPremProviderRef,
  encodeOnPremProviderRef,
  onPremEnrollmentRequestSchema,
  onPremEnrollRequestSchema,
  onPremExchangeRequestSchema,
  onPremInstanceTypesSchema,
  onPremOperationSchema,
  onPremOrganizationIdSchema,
  onPremProfileSchema,
  onPremProviderBindingSchema,
  onPremReportSchema,
  onPremRevokeRequestSchema,
  onPremSelectRequestSchema,
  type OnPremEnrollmentRequest,
  type OnPremEnrollmentResponse,
  type OnPremEnrollRequest,
  type OnPremEnrollResponse,
  type OnPremExchangeRequest,
  type OnPremExchangeResponse,
  type OnPremOperation,
  type OnPremProfile,
  type OnPremProviderBinding,
  type OnPremReport,
  type OnPremRevokeRequest,
  type OnPremSelectRequest,
  type OnPremStatus,
} from '../shared/onprem-protocol.js';
import { generateSandboxCredential } from '../sandbox-control/credential.js';
import { sha256Hex } from '../utils/sha256.js';

const STATE_KEY = 'onprem_installation_v1';
const ENROLLMENT_TTL_MS = 10 * 60_000;
const CREATE_TTL_MS = 5 * 60_000;
const FRESHNESS_MS = 60_000;
const MAX_ALLOCATIONS = 128;
const MAX_REPORT_RECEIPTS = 1024;
const MAX_BOOTSTRAP_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const timestampSchema = onPremReportSchema.shape.observedAt;
const hashSchema = onPremEnrollRequestSchema.shape.credentialHash;
const credentialSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const reserveInputSchema = z
  .object({
    binding: onPremProviderBindingSchema,
    allocationId: onPremReportSchema.shape.allocationId,
    sandboxId: onPremOperationSchema.options[0].shape.sandboxId,
    allocationName: z.string().min(1).max(256),
    createdAt: timestampSchema,
    profile: onPremProfileSchema,
  })
  .strict();
const launchInputSchema = onPremOperationSchema.options[0].pick({
  providerRef: true,
  bootstrap: true,
  notAfter: true,
});
const authorizeInputSchema = z
  .object({
    installationId: onPremProviderBindingSchema.shape.installationId,
    credential: credentialSchema,
    providerRef: launchInputSchema.shape.providerRef,
    podUid: onPremReportSchema.shape.pod.unwrap().shape.uid,
  })
  .strict();
const allocationSchema = reserveInputSchema.extend({
  providerRef: launchInputSchema.shape.providerRef,
  hardStopAt: timestampSchema,
  phase: z.enum(['reserved', 'launched', 'stopping', 'terminal']),
  revision: onPremReportSchema.shape.revision,
  issuedAt: timestampSchema,
  launchDigest: hashSchema.nullable(),
  notAfter: timestampSchema.nullable(),
  operation: onPremOperationSchema.nullable(),
  pod: onPremReportSchema.shape.pod.unwrap().nullable(),
  report: onPremReportSchema.nullable(),
  reportReceivedAt: timestampSchema.nullable(),
  terminalAt: timestampSchema.nullable(),
  lastDeliveredAt: timestampSchema.nullable(),
});
const installationSchema = z
  .object({
    id: onPremProviderBindingSchema.shape.installationId,
    name: onPremEnrollmentRequestSchema.shape.name,
    bootstrapHash: hashSchema.nullable(),
    bootstrapExpiresAt: timestampSchema,
    credentialHash: hashSchema.nullable(),
    enrolledAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
    lastSeenAt: timestampSchema.nullable(),
    runnerVersion: onPremEnrollRequestSchema.shape.runnerVersion.nullable(),
    profile: onPremProfileSchema.nullable(),
    instanceTypes: onPremInstanceTypesSchema.default([]),
    ready: z.boolean(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    selected: z.boolean(),
    installation: installationSchema.nullable(),
    allocations: z.array(allocationSchema).max(MAX_ALLOCATIONS),
    reports: z
      .array(z.object({ id: onPremReportSchema.shape.id, receivedAt: timestampSchema }).strict())
      .max(MAX_REPORT_RECEIPTS),
  })
  .strict();

type Installation = z.infer<typeof installationSchema>;
type Allocation = z.infer<typeof allocationSchema>;
type State = z.infer<typeof stateSchema>;
export type ReserveOnPremAllocationInput = z.infer<typeof reserveInputSchema>;
export type LaunchOnPremAllocationInput = z.infer<typeof launchInputSchema>;
export type AuthorizeOnPremAllocationInput = z.infer<typeof authorizeInputSchema>;
export type OnPremAllocationInfo = Pick<
  Allocation,
  | 'binding'
  | 'allocationId'
  | 'sandboxId'
  | 'allocationName'
  | 'createdAt'
  | 'profile'
  | 'providerRef'
  | 'hardStopAt'
  | 'phase'
  | 'revision'
  | 'notAfter'
  | 'pod'
> & {
  status: 'active' | 'terminal' | 'unknown';
  acknowledgedAt: number | null;
  acknowledgementFresh: boolean;
};

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('onprem_invalid_request');
  return result.data;
}

function sameProfile(left: OnPremProfile, right: OnPremProfile): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.runtimeClass === right.runtimeClass &&
    left.image === right.image &&
    left.brokerUrl === right.brokerUrl &&
    left.maxLifetimeMs === right.maxLifetimeMs
  );
}

function ownedInstallation(state: State, installationId: string): Installation {
  const installation = state.installation;
  if (!installation || installation.id !== installationId) {
    throw new Error('onprem_installation_not_found');
  }
  return installation;
}

function readyProfile(state: State, binding: OnPremProviderBinding, now: number): OnPremProfile {
  const installation = ownedInstallation(state, binding.installationId);
  if (installation.revokedAt !== null) throw new Error('onprem_installation_revoked');
  if (!installation.profile || installation.profile.id !== binding.profileId) {
    throw new Error('onprem_profile_mismatch');
  }
  if (
    !installation.ready ||
    installation.lastSeenAt === null ||
    installation.lastSeenAt + FRESHNESS_MS <= now
  ) {
    throw new Error('onprem_installation_not_ready');
  }
  return installation.profile;
}

function allocationForRef(state: State, providerRef: string): Allocation | undefined {
  const identity = decodeOnPremProviderRef(providerRef);
  if (!identity) throw new Error('onprem_invalid_request');
  return state.allocations.find(
    allocation =>
      allocation.allocationId === identity.allocationId &&
      allocation.binding.installationId === identity.installationId &&
      allocation.providerRef === providerRef
  );
}

function requestStop(allocation: Allocation, reason: string, now: number): void {
  if (allocation.phase === 'terminal' || allocation.phase === 'stopping') return;
  allocation.phase = 'stopping';
  allocation.revision += 1;
  allocation.issuedAt = now;
  allocation.lastDeliveredAt = null;
  allocation.operation = {
    id: crypto.randomUUID(),
    allocationId: allocation.allocationId,
    sandboxId: allocation.sandboxId,
    providerRef: allocation.providerRef,
    revision: allocation.revision,
    type: 'stop',
    reason,
  };
}

function expireState(state: State, now: number): void {
  for (const allocation of state.allocations) {
    if (allocation.hardStopAt <= now) {
      requestStop(allocation, 'lifetime_expired', now);
    } else if (
      (allocation.phase === 'reserved' && allocation.createdAt + CREATE_TTL_MS <= now) ||
      (allocation.operation?.type === 'launch' && allocation.operation.notAfter <= now)
    ) {
      requestStop(allocation, 'launch_expired', now);
    }
  }
  state.allocations = state.allocations.filter(
    allocation =>
      allocation.terminalAt === null ||
      Math.max(allocation.terminalAt, allocation.hardStopAt) + ON_PREM_ALLOCATION_REPLAY_WINDOW_MS >
        now
  );
  state.reports = state.reports.filter(receipt => receipt.receivedAt + 2 * FRESHNESS_MS > now);
  const installation = state.installation;
  if (
    installation &&
    installation.revokedAt !== null &&
    !state.allocations.some(allocation => allocation.binding.installationId === installation.id)
  ) {
    installation.credentialHash = null;
  }
}

function allocationInfo(allocation: Allocation, now: number): OnPremAllocationInfo {
  const report = allocation.report;
  const acknowledgedAt =
    report?.status === 'active' && report.revision === allocation.revision && allocation.pod
      ? Math.min(report.observedAt, allocation.reportReceivedAt ?? 0)
      : null;
  const acknowledgementFresh =
    allocation.phase === 'launched' &&
    allocation.hardStopAt > now &&
    acknowledgedAt !== null &&
    acknowledgedAt + FRESHNESS_MS > now;
  return {
    binding: allocation.binding,
    allocationId: allocation.allocationId,
    sandboxId: allocation.sandboxId,
    allocationName: allocation.allocationName,
    createdAt: allocation.createdAt,
    profile: allocation.profile,
    providerRef: allocation.providerRef,
    hardStopAt: allocation.hardStopAt,
    phase: allocation.phase,
    revision: allocation.revision,
    notAfter: allocation.notAfter,
    pod: allocation.pod,
    status:
      allocation.phase === 'terminal' ? 'terminal' : acknowledgementFresh ? 'active' : 'unknown',
    acknowledgedAt,
    acknowledgementFresh,
  };
}

function confirmsReport(allocation: Allocation, report: OnPremReport): boolean {
  if (
    allocation.pod?.uid !== report.pod?.uid ||
    allocation.pod?.name !== report.pod?.name ||
    allocation.pod?.namespace !== report.pod?.namespace
  ) {
    return false;
  }
  return report.status === 'pending'
    ? report.pod !== undefined &&
        allocation.phase === 'launched' &&
        report.revision === allocation.revision
    : report.status === 'terminal' && allocation.phase === 'terminal';
}

function applyReport(state: State, report: OnPremReport, now: number): boolean {
  const allocation = state.allocations.find(
    value =>
      value.allocationId === report.allocationId &&
      value.binding.installationId === state.installation?.id
  );
  if (!allocation) return false;
  const requiresConfirmation = report.status === 'pending' || report.status === 'terminal';
  const receipt = state.reports.some(receipt => receipt.id === report.id);
  if (allocation.report?.id === report.id || receipt) {
    if (!requiresConfirmation || confirmsReport(allocation, report)) return true;
  }
  if (report.status === 'terminal' && confirmsReport(allocation, report)) return true;
  if (!receipt && state.reports.length >= MAX_REPORT_RECEIPTS) return false;
  const staleLiveReport =
    report.status !== 'terminal' &&
    (report.observedAt + ON_PREM_CLOCK_SKEW_MS < allocation.issuedAt ||
      report.observedAt + FRESHNESS_MS <= now ||
      (allocation.report !== null && report.observedAt <= allocation.report.observedAt));
  if (
    allocation.phase === 'terminal' ||
    allocation.phase === 'reserved' ||
    report.revision !== allocation.revision ||
    report.observedAt + ON_PREM_CLOCK_SKEW_MS < allocation.createdAt ||
    report.observedAt > now + ON_PREM_CLOCK_SKEW_MS ||
    staleLiveReport ||
    (report.status === 'pending' && (!report.pod || allocation.phase !== 'launched'))
  ) {
    if (requiresConfirmation) return false;
  } else if (
    allocation.pod &&
    report.pod &&
    (report.pod.uid !== allocation.pod.uid ||
      report.pod.name !== allocation.pod.name ||
      report.pod.namespace !== allocation.pod.namespace)
  ) {
    requestStop(allocation, 'pod_identity_mismatch', now);
    if (requiresConfirmation) return false;
  } else {
    if (!allocation.pod && report.pod) allocation.pod = report.pod;
    const missingPod =
      (report.status === 'active' || (report.status === 'terminal' && allocation.pod !== null)) &&
      !report.pod;
    allocation.report = missingPod ? { ...report, status: 'unknown' } : report;
    allocation.reportReceivedAt = now;
    if (allocation.report.status === 'terminal') {
      allocation.phase = 'terminal';
      allocation.terminalAt = now;
      allocation.operation = null;
    } else if (report.status === 'rejected') {
      requestStop(allocation, 'launch_rejected', now);
    } else if (allocation.phase === 'launched' && allocation.report.status === 'active') {
      allocation.operation = null;
    }
    if (requiresConfirmation && !confirmsReport(allocation, report)) return false;
  }
  if (!receipt) state.reports.push({ id: report.id, receivedAt: now });
  return true;
}

export class OnPremInstallation extends DurableObject<Cloudflare.Env> {
  private assertOrganization(organizationId: string): string {
    const parsed = onPremOrganizationIdSchema.safeParse(organizationId);
    if (!parsed.success || parsed.data !== this.ctx.id.name) {
      throw new Error('onprem_organization_mismatch');
    }
    return parsed.data;
  }

  private async update<T>(operation: (state: State, now: number) => T): Promise<T> {
    this.assertOrganization(this.ctx.id.name ?? '');
    return this.ctx.storage.transaction(async transaction => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const parsed = stateSchema.safeParse(stored);
      if (stored !== undefined && !parsed.success) throw new Error('onprem_state_invalid');
      const state: State = parsed.success
        ? parsed.data
        : { version: 1, selected: false, installation: null, allocations: [], reports: [] };
      const now = Date.now();
      expireState(state, now);
      const result = operation(state, now);
      if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_STATE_BYTES) {
        throw new Error('onprem_capacity_exceeded');
      }
      await transaction.put(STATE_KEY, state);
      const deadlines: number[] = [];
      for (const allocation of state.allocations) {
        if (allocation.terminalAt !== null) {
          deadlines.push(
            Math.max(allocation.terminalAt, allocation.hardStopAt) +
              ON_PREM_ALLOCATION_REPLAY_WINDOW_MS
          );
        } else if (allocation.phase !== 'stopping') {
          deadlines.push(allocation.hardStopAt);
          if (allocation.phase === 'reserved') deadlines.push(allocation.createdAt + CREATE_TTL_MS);
          if (allocation.operation?.type === 'launch')
            deadlines.push(allocation.operation.notAfter);
        }
      }
      if (deadlines.length > 0) {
        await transaction.setAlarm(Math.max(now + 1, Math.min(...deadlines)));
      } else {
        await transaction.deleteAlarm();
      }
      return result;
    });
  }

  private status(state: State, now: number): OnPremStatus {
    const installation = state.installation;
    if (!installation) return { selected: state.selected, installation: null };
    const revoked = installation.revokedAt !== null;
    const expired = installation.enrolledAt === null && installation.bootstrapExpiresAt <= now;
    const offline =
      installation.lastSeenAt !== null && installation.lastSeenAt + FRESHNESS_MS <= now;
    return {
      selected: state.selected,
      installation: {
        id: installation.id,
        organizationId: this.ctx.id.name ?? '',
        name: installation.name,
        state: revoked
          ? 'revoked'
          : expired
            ? 'failed'
            : offline
              ? 'offline'
              : installation.lastSeenAt === null
                ? 'pending'
                : installation.ready
                  ? 'ready'
                  : 'failed',
        enrolledAt:
          installation.enrolledAt === null ? null : new Date(installation.enrolledAt).toISOString(),
        lastSeenAt:
          installation.lastSeenAt === null ? null : new Date(installation.lastSeenAt).toISOString(),
        runnerVersion: installation.runnerVersion,
        profile: installation.profile,
        instanceTypes: installation.instanceTypes,
        diagnosticCode: revoked
          ? 'installation_revoked'
          : expired
            ? 'enrollment_expired'
            : offline
              ? 'runner_offline'
              : installation.lastSeenAt !== null && !installation.ready
                ? 'runner_not_ready'
                : null,
        activeAllocations: state.allocations.filter(allocation => allocation.phase !== 'terminal')
          .length,
        cleanupPending: state.allocations.some(allocation => allocation.phase === 'stopping'),
      },
    };
  }

  async getStatus(organizationId: string): Promise<OnPremStatus> {
    this.assertOrganization(organizationId);
    return this.update((state, now) => this.status(state, now));
  }

  async createEnrollment(
    organizationId: string,
    input: OnPremEnrollmentRequest
  ): Promise<OnPremEnrollmentResponse> {
    const canonicalOrganizationId = this.assertOrganization(organizationId);
    const { name } = parse(onPremEnrollmentRequestSchema, input);
    const bootstrapToken = generateSandboxCredential();
    const bootstrapHash = await sha256Hex(bootstrapToken);
    return this.update((state, now) => {
      const previous = state.installation;
      if (previous && previous.enrolledAt !== null && previous.revokedAt === null) {
        throw new Error('onprem_already_enrolled');
      }
      if (previous && previous.revokedAt !== null) {
        if (state.allocations.some(allocation => allocation.phase !== 'terminal')) {
          throw new Error('onprem_cleanup_pending');
        }
        if (state.selected) throw new Error('onprem_selection_conflict');
      }
      const id = previous && previous.revokedAt === null ? previous.id : crypto.randomUUID();
      const expiresAt = now + ENROLLMENT_TTL_MS;
      state.installation = {
        id,
        name,
        bootstrapHash,
        bootstrapExpiresAt: expiresAt,
        credentialHash: null,
        enrolledAt: null,
        revokedAt: null,
        lastSeenAt: null,
        runnerVersion: null,
        profile: null,
        instanceTypes: [],
        ready: false,
      };
      return {
        installationId: id,
        organizationId: canonicalOrganizationId,
        bootstrapToken,
        expiresAt: new Date(expiresAt).toISOString(),
        protocolVersion: ON_PREM_PROTOCOL_VERSION,
      };
    });
  }

  async enroll(
    installationId: string,
    bootstrapToken: string,
    input: OnPremEnrollRequest
  ): Promise<OnPremEnrollResponse> {
    const request = parse(onPremEnrollRequestSchema, input);
    const digest = await sha256Hex(parse(credentialSchema, bootstrapToken));
    return this.update((state, now) => {
      const installation = ownedInstallation(state, installationId);
      if (
        installation.revokedAt !== null ||
        !installation.bootstrapHash ||
        !timingSafeEqual(digest, installation.bootstrapHash)
      ) {
        throw new Error('onprem_unauthorized');
      }
      if (installation.credentialHash !== null) {
        if (!timingSafeEqual(request.credentialHash, installation.credentialHash)) {
          throw new Error('onprem_unauthorized');
        }
        if (!installation.profile || !sameProfile(request.profile, installation.profile)) {
          throw new Error('onprem_profile_mismatch');
        }
      } else {
        if (installation.bootstrapExpiresAt <= now) throw new Error('onprem_enrollment_expired');
        installation.credentialHash = request.credentialHash;
        installation.enrolledAt = now;
        installation.runnerVersion = request.runnerVersion;
        installation.profile = request.profile;
      }
      return { protocolVersion: ON_PREM_PROTOCOL_VERSION, installationId };
    });
  }

  async select(organizationId: string, input: OnPremSelectRequest): Promise<OnPremStatus> {
    const canonicalOrganizationId = this.assertOrganization(organizationId);
    const request = parse(onPremSelectRequestSchema, input);
    return this.update((state, now) => {
      ownedInstallation(state, request.installationId);
      if (request.selected) {
        readyProfile(
          state,
          {
            kind: 'onprem',
            organizationId: canonicalOrganizationId,
            installationId: request.installationId,
            profileId: request.profileId,
          },
          now
        );
      }
      state.selected = request.selected;
      return this.status(state, now);
    });
  }

  async revoke(organizationId: string, input: OnPremRevokeRequest): Promise<OnPremStatus> {
    this.assertOrganization(organizationId);
    const request = parse(onPremRevokeRequestSchema, input);
    return this.update((state, now) => {
      const installation = ownedInstallation(state, request.installationId);
      installation.revokedAt ??= now;
      installation.bootstrapHash = null;
      installation.ready = false;
      for (const allocation of state.allocations)
        requestStop(allocation, 'installation_revoked', now);
      expireState(state, now);
      return this.status(state, now);
    });
  }

  async exchange(
    installationId: string,
    credential: string,
    input: OnPremExchangeRequest
  ): Promise<OnPremExchangeResponse> {
    const request = parse(onPremExchangeRequestSchema, input);
    const digest = await sha256Hex(parse(credentialSchema, credential));
    return this.update((state, now) => {
      const installation = ownedInstallation(state, installationId);
      if (!installation.credentialHash || !timingSafeEqual(digest, installation.credentialHash)) {
        throw new Error('onprem_unauthorized');
      }
      const revoked = installation.revokedAt !== null;
      installation.lastSeenAt = now;
      if (!revoked) {
        installation.ready = request.ready && request.diagnosticCode === null;
        installation.runnerVersion = request.runnerVersion;
        installation.instanceTypes = request.instanceTypes ?? [];
      }
      const acknowledgedReportIds = request.reports
        .filter(report => applyReport(state, report, now))
        .map(report => report.id);
      const pending = state.allocations
        .filter(
          allocation =>
            allocation.binding.installationId === installationId &&
            allocation.operation !== null &&
            (allocation.operation.type === 'stop' || (!revoked && installation.ready))
        )
        .sort(
          (left, right) =>
            Number(right.operation?.type === 'stop') - Number(left.operation?.type === 'stop') ||
            (left.lastDeliveredAt ?? 0) - (right.lastDeliveredAt ?? 0)
        )
        .slice(0, ON_PREM_MAX_BATCH_SIZE);
      const operations: OnPremOperation[] = [];
      for (const allocation of pending) {
        if (!allocation.operation) continue;
        allocation.lastDeliveredAt = now;
        operations.push(allocation.operation);
      }
      return {
        protocolVersion: ON_PREM_PROTOCOL_VERSION,
        serverTime: now,
        revoked,
        acknowledgedReportIds: [...new Set(acknowledgedReportIds)],
        operations,
        pollAfterMs: operations.length > 0 ? 1_000 : revoked ? 30_000 : 5_000,
      };
    });
  }

  async getSelectedBinding(organizationId: string): Promise<OnPremProviderBinding | null> {
    const canonicalOrganizationId = this.assertOrganization(organizationId);
    return this.update(state => {
      if (!state.selected) return null;
      const installation = state.installation;
      if (!installation?.profile) throw new Error('onprem_installation_not_ready');
      return {
        kind: 'onprem',
        organizationId: canonicalOrganizationId,
        installationId: installation.id,
        profileId: installation.profile.id,
      };
    });
  }

  async resolveProfile(binding: OnPremProviderBinding): Promise<OnPremProfile> {
    const parsed = parse(onPremProviderBindingSchema, binding);
    this.assertOrganization(parsed.organizationId);
    return this.update((state, now) => readyProfile(state, parsed, now));
  }

  async reserveAllocation(
    input: ReserveOnPremAllocationInput
  ): Promise<{ providerRef: string; hardStopAt: number }> {
    const request = parse(reserveInputSchema, input);
    this.assertOrganization(request.binding.organizationId);
    return this.update((state, now) => {
      const profile = readyProfile(state, request.binding, now);
      if (!sameProfile(profile, request.profile)) throw new Error('onprem_profile_mismatch');
      if (
        request.createdAt > now + ON_PREM_CLOCK_SKEW_MS ||
        request.createdAt + CREATE_TTL_MS <= now
      ) {
        throw new Error('onprem_allocation_expired');
      }
      const existing = state.allocations.find(value => value.allocationId === request.allocationId);
      if (existing) {
        if (
          existing.binding.installationId !== request.binding.installationId ||
          existing.sandboxId !== request.sandboxId ||
          existing.allocationName !== request.allocationName ||
          existing.createdAt !== request.createdAt ||
          !sameProfile(existing.profile, request.profile)
        ) {
          throw new Error('onprem_allocation_conflict');
        }
        return { providerRef: existing.providerRef, hardStopAt: existing.hardStopAt };
      }
      if (
        state.allocations.some(
          allocation =>
            allocation.sandboxId === request.sandboxId && allocation.phase !== 'terminal'
        )
      ) {
        throw new Error('onprem_allocation_conflict');
      }
      if (state.allocations.length >= MAX_ALLOCATIONS) throw new Error('onprem_capacity_exceeded');
      const providerRef = encodeOnPremProviderRef({
        installationId: request.binding.installationId,
        allocationId: request.allocationId,
      });
      const hardStopAt = request.createdAt + profile.maxLifetimeMs;
      state.allocations.push({
        ...request,
        providerRef,
        hardStopAt,
        phase: 'reserved',
        revision: 0,
        issuedAt: now,
        launchDigest: null,
        notAfter: null,
        operation: null,
        pod: null,
        report: null,
        reportReceivedAt: null,
        terminalAt: null,
        lastDeliveredAt: null,
      });
      return { providerRef, hardStopAt };
    });
  }

  async launchAllocation(input: LaunchOnPremAllocationInput): Promise<void> {
    const request = parse(launchInputSchema, input);
    const digest = await sha256Hex(JSON.stringify(Object.entries(request.bootstrap).sort()));
    return this.update((state, now) => {
      const allocation = allocationForRef(state, request.providerRef);
      if (!allocation) throw new Error('onprem_allocation_not_found');
      readyProfile(state, allocation.binding, now);
      if (allocation.phase === 'stopping' || allocation.phase === 'terminal') {
        throw new Error('onprem_allocation_stopped');
      }
      if (
        request.notAfter <= now ||
        request.notAfter > allocation.hardStopAt ||
        request.notAfter > allocation.createdAt + CREATE_TTL_MS
      ) {
        throw new Error('onprem_allocation_expired');
      }
      if (allocation.launchDigest !== null) {
        if (
          allocation.notAfter !== request.notAfter ||
          !timingSafeEqual(allocation.launchDigest, digest)
        ) {
          throw new Error('onprem_allocation_conflict');
        }
        return;
      }
      const operation = parse(onPremOperationSchema, {
        id: crypto.randomUUID(),
        allocationId: allocation.allocationId,
        sandboxId: allocation.sandboxId,
        providerRef: allocation.providerRef,
        revision: allocation.revision + 1,
        type: 'launch',
        profileId: allocation.profile.id,
        profileRevision: allocation.profile.revision,
        hardStopAt: allocation.hardStopAt,
        notAfter: request.notAfter,
        bootstrap: request.bootstrap,
      });
      const bootstrapBytes = new TextEncoder().encode(
        JSON.stringify([
          request.bootstrap,
          ...state.allocations.flatMap(value =>
            value.operation?.type === 'launch' ? [value.operation.bootstrap] : []
          ),
        ])
      ).byteLength;
      if (bootstrapBytes > MAX_BOOTSTRAP_BYTES) throw new Error('onprem_capacity_exceeded');
      allocation.phase = 'launched';
      allocation.revision = operation.revision;
      allocation.issuedAt = now;
      allocation.launchDigest = digest;
      allocation.notAfter = request.notAfter;
      allocation.operation = operation;
    });
  }

  async getAllocation(providerRef: string): Promise<OnPremAllocationInfo | null> {
    return this.update((state, now) => {
      const allocation = allocationForRef(state, providerRef);
      return allocation ? allocationInfo(allocation, now) : null;
    });
  }

  async observeAllocation(
    providerRef: string
  ): Promise<{ status: 'active' | 'terminal' | 'unknown'; providerRef: string }> {
    const allocation = await this.getAllocation(providerRef);
    return { status: allocation?.status ?? 'unknown', providerRef };
  }

  async stopAllocation(providerRef: string, reason?: string): Promise<'terminal' | 'retryable'> {
    const parsedReason = onPremOperationSchema.options[1].shape.reason.safeParse(reason);
    return this.update((state, now) => {
      const allocation = allocationForRef(state, providerRef);
      if (!allocation) return 'retryable';
      requestStop(allocation, parsedReason.success ? parsedReason.data : 'stop_requested', now);
      return allocation.phase === 'terminal' ? 'terminal' : 'retryable';
    });
  }

  async authorizeAllocation(
    input: AuthorizeOnPremAllocationInput
  ): Promise<{ sandboxId: string; allocationId: string; binding: OnPremProviderBinding }> {
    const request = parse(authorizeInputSchema, input);
    const digest = await sha256Hex(request.credential);
    return this.update((state, now) => {
      const installation = ownedInstallation(state, request.installationId);
      if (
        installation.revokedAt !== null ||
        !installation.credentialHash ||
        !timingSafeEqual(digest, installation.credentialHash)
      ) {
        throw new Error('onprem_unauthorized');
      }
      const allocation = allocationForRef(state, request.providerRef);
      if (
        !allocation ||
        allocation.binding.installationId !== installation.id ||
        allocation.pod?.uid !== request.podUid ||
        !allocationInfo(allocation, now).acknowledgementFresh
      ) {
        throw new Error('onprem_unauthorized');
      }
      readyProfile(state, allocation.binding, now);
      return {
        sandboxId: allocation.sandboxId,
        allocationId: allocation.allocationId,
        binding: allocation.binding,
      };
    });
  }

  async alarm(): Promise<void> {
    await this.update(() => undefined);
  }
}
