import { type Operation } from '@trpc/client';
import {
  createUserWebConnection,
  type UserWebActionTarget,
  type UserWebConnection,
  type UserWebConnectionConfig,
} from '@kilocode/cloud-agent-sdk/user-web-connection';
import { z } from 'zod';

import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { type AuthenticatedOwner, getAuthenticatedOwner } from '@/lib/context-scope';
import {
  assertLocalAccessLease,
  assertLocalAccessOwner,
  captureLocalAccessLease,
  LocalAccessDeniedError,
  type LocalAccessLease,
  type LocalAccessScope,
} from '@/lib/local-access';

/** Credential ownership also works before getMe and context restoration finish. */
export function isTransportOwner(owner: AuthenticatedOwner, allowCleanup = false): boolean {
  const current = getAuthenticatedOwner();
  return (
    (allowCleanup || !isSignOutActive()) &&
    isCurrentAuthEpoch(owner.authEpoch) &&
    owner.authEpoch === current.authEpoch &&
    owner.generation === current.generation &&
    (owner.userId === null || owner.userId === current.userId)
  );
}

export function assertTransportOwner(owner: AuthenticatedOwner, allowCleanup = false): void {
  if (!isTransportOwner(owner, allowCleanup)) {
    throw new LocalAccessDeniedError('owner');
  }
}

/** tRPC keeps transport denials in Error.cause; callers still receive the original typed denial. */
export function getLocalAccessDenial(error: unknown): LocalAccessDeniedError | null {
  if (error instanceof LocalAccessDeniedError) {
    return error;
  }
  return error instanceof Error && error.cause instanceof LocalAccessDeniedError
    ? error.cause
    : null;
}

export type MobileActionAdmission = Readonly<{
  owner: AuthenticatedOwner;
  lease: LocalAccessLease;
}>;
const admissions = new WeakSet<MobileActionAdmission>();

export function captureMobileActionAdmission(
  owner: AuthenticatedOwner,
  organizationId: string | null
): MobileActionAdmission {
  assertTransportOwner(owner);
  if (!owner.userId) {
    throw new LocalAccessDeniedError('owner');
  }
  const admission = Object.freeze({
    owner,
    lease: captureLocalAccessLease({ userId: owner.userId, organizationId }),
  });
  admissions.add(admission);
  return admission;
}

export function assertMobileActionAdmission(admission: MobileActionAdmission): void {
  if (!admissions.has(admission)) {
    throw new LocalAccessDeniedError('stale');
  }
  assertTransportOwner(admission.owner);
  assertLocalAccessLease(admission.lease);
}

const receiptBrand = Symbol('AcceptedWorkReceipt');
type AcceptedWorkKind = 'quick-chat-turn' | 'app-store-purchase';
export type AcceptedWorkReceipt = Readonly<{ [receiptBrand]: true }>;
type AcceptedWorkIdentity = Readonly<{ kind: AcceptedWorkKind; workId: string }>;
type AcceptedWork = MobileActionAdmission & AcceptedWorkIdentity;
type AcceptedWorkTarget = Readonly<{
  kind: AcceptedWorkKind;
  organizationId: string | null;
  workId?: string;
}>;
const acceptedWork = new WeakMap<AcceptedWorkReceipt, AcceptedWork>();

/** Issue proof only after the synchronous dispatch boundary accepts the original lease. */
export function dispatchAcceptedWork<T>(
  admission: MobileActionAdmission,
  work: AcceptedWorkIdentity,
  dispatch: () => T
) {
  assertMobileActionAdmission(admission);
  const result = dispatch();
  const receipt: AcceptedWorkReceipt = Object.freeze({ [receiptBrand]: true });
  acceptedWork.set(receipt, { ...admission, ...work });
  return { result, receipt };
}

export function assertAcceptedWorkReceipt(
  receipt: AcceptedWorkReceipt,
  target: AcceptedWorkTarget
): AcceptedWork {
  const work = acceptedWork.get(receipt);
  if (
    !work ||
    work.kind !== target.kind ||
    work.lease.organizationId !== target.organizationId ||
    (target.workId !== undefined && work.workId !== target.workId)
  ) {
    throw new LocalAccessDeniedError('stale');
  }
  assertTransportOwner(work.owner);
  // Completion belongs to the admitted context, not the current global selection or unlock grant.
  assertLocalAccessOwner(work.lease);
  return work;
}

const ownerSchema = z.object({
  authEpoch: z.number(),
  generation: z.number(),
  userId: z.string().nullable(),
});
const inputScopeSchema = z.object({ organizationId: z.string().nullish() }).optional();
const appendInputSchema = z.object({
  organizationId: z.string().nullish(),
  messages: z.array(z.object({ clientId: z.string().optional() })),
});
const admissionSchema = z.custom<MobileActionAdmission>(value =>
  admissions.has(value as MobileActionAdmission)
);
const receiptSchema = z.custom<AcceptedWorkReceipt>(value =>
  acceptedWork.has(value as AcceptedWorkReceipt)
);

export type TransportOperation = Readonly<{
  owner: AuthenticatedOwner;
  type: Operation['type'];
  path: string;
  allowCleanup: boolean;
  assertDispatch: () => void;
}>;

/** Exact exceptions only. A new mutation is a foreground action until explicitly classified. */
export function captureTransportOperation(op: Operation): TransportOperation {
  const allowCleanup =
    op.type === 'mutation' &&
    (op.path === 'user.unregisterPushToken' || op.path === 'user.revokeCurrentDeviceSession');
  const owner =
    op.context.localAccessOwner === undefined
      ? getAuthenticatedOwner()
      : ownerSchema.parse(op.context.localAccessOwner);
  const assertOwner = () => {
    assertTransportOwner(owner, allowCleanup);
  };
  assertOwner();
  const operation = { owner, type: op.type, path: op.path, allowCleanup };
  if (op.type !== 'mutation') {
    return { ...operation, assertDispatch: assertOwner };
  }
  switch (op.path) {
    case 'activeSessions.createWebTicket':
    case 'user.registerPushToken':
    case 'user.unregisterPushToken':
    case 'user.revokeCurrentDeviceSession': {
      return { ...operation, assertDispatch: assertOwner };
    }
    case 'kiloPass.completeAppStorePurchase': {
      // Old StoreKit consumers have no local receipt. Keep backend signed-JWS/appAccountToken
      // verification and this credential fence until a4 migrates every completion consumer.
      if (op.context.localAccessReceipt === undefined) {
        return { ...operation, assertDispatch: assertOwner };
      }
      const receipt = receiptSchema.safeParse(op.context.localAccessReceipt);
      if (!receipt.success) {
        throw new LocalAccessDeniedError('stale');
      }
      const assertDispatch = () => {
        assertOwner();
        const work = assertAcceptedWorkReceipt(receipt.data, {
          kind: 'app-store-purchase',
          organizationId: null,
        });
        if (work.owner.userId !== owner.userId) {
          throw new LocalAccessDeniedError('owner');
        }
      };
      assertDispatch();
      return { ...operation, assertDispatch };
    }
    case 'quickChat.appendMessages': {
      const receipt = receiptSchema.safeParse(op.context.localAccessReceipt);
      const input = appendInputSchema.safeParse(op.input);
      if (!receipt.success || !input.success || !input.data.messages[0]?.clientId) {
        throw new LocalAccessDeniedError('stale');
      }
      const assertDispatch = () => {
        assertOwner();
        const work = assertAcceptedWorkReceipt(receipt.data, {
          kind: 'quick-chat-turn',
          organizationId: input.data.organizationId ?? null,
          workId: input.data.messages[0]?.clientId,
        });
        if (work.owner.userId !== owner.userId) {
          throw new LocalAccessDeniedError('owner');
        }
      };
      assertDispatch();
      return { ...operation, assertDispatch };
    }
    default: {
      break;
    }
  }
  const organizationId = inputScopeSchema.parse(op.input)?.organizationId ?? null;
  const supplied = op.context.localAccessAdmission;
  const parsed = supplied === undefined ? null : admissionSchema.safeParse(supplied);
  if (parsed && !parsed.success) {
    throw new LocalAccessDeniedError('stale');
  }
  const admission = parsed?.data ?? captureMobileActionAdmission(owner, organizationId);
  const assertDispatch = () => {
    assertOwner();
    if (
      admission.lease.organizationId !== organizationId ||
      admission.owner.userId !== owner.userId
    ) {
      throw new LocalAccessDeniedError('context');
    }
    assertMobileActionAdmission(admission);
  };
  assertDispatch();
  return { ...operation, assertDispatch };
}

export type MobileUserWebConnection = UserWebConnection &
  Readonly<{
    owner: AuthenticatedOwner;
    setSessionScope: (sessionId: string, organizationId: string | null) => void;
  }>;
type MobileConnectionConfig = Omit<UserWebConnectionConfig, 'captureActionAdmission'> & {
  owner: AuthenticatedOwner;
  captureActionAdmission: (target: UserWebActionTarget, scope?: LocalAccessScope) => () => void;
};

/**
 * Mobile requires admission. The SDK's old constructor without a hook remains for web,
 * extension, and external callers until a breaking SDK release migrates those producers.
 */
export function createMobileUserWebConnection({
  owner,
  captureActionAdmission,
  getAuthToken,
  ...config
}: MobileConnectionConfig): MobileUserWebConnection {
  const scopes = new Map<string, LocalAccessScope>();
  const assertOwner = () => {
    assertTransportOwner(owner);
    if (!owner.userId) {
      throw new LocalAccessDeniedError('owner');
    }
  };
  const connection = createUserWebConnection({
    ...config,
    getAuthToken: async () => {
      assertOwner();
      const token = await getAuthToken();
      assertOwner();
      return token;
    },
    captureActionAdmission: target => {
      assertOwner();
      const assert = captureActionAdmission(
        target,
        target.sessionId ? scopes.get(target.sessionId) : undefined
      );
      return () => {
        assertOwner();
        assert();
      };
    },
  });
  function whenCurrent<T extends unknown[]>(listener: (...args: T) => void) {
    return (...args: T) => {
      if (isTransportOwner(owner)) {
        listener(...args);
      }
    };
  }
  return {
    ...connection,
    owner,
    onSystemEvent: listener => connection.onSystemEvent(whenCurrent(listener)),
    onCliEvent: (sessionId, listener) => connection.onCliEvent(sessionId, whenCurrent(listener)),
    onSessionEvent: (event, listener) => connection.onSessionEvent(event, whenCurrent(listener)),
    onReconnect: listener => connection.onReconnect(whenCurrent(listener)),
    onConnectionChange: listener => connection.onConnectionChange(whenCurrent(listener)),
    onReconnectExhaustionChange: listener =>
      connection.onReconnectExhaustionChange(whenCurrent(listener)),
    destroy() {
      scopes.clear();
      connection.destroy();
    },
    setSessionScope: (sessionId, organizationId) => {
      assertOwner();
      if (owner.userId) {
        scopes.set(sessionId, { userId: owner.userId, organizationId });
      }
    },
  };
}
