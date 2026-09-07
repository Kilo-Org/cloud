import { withTimeout } from '@kilocode/worker-utils';
import { z } from 'zod';
import type { Env } from '../types.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import {
  controlSessionStateSchema,
  controlStopReceiptSchema,
  controlStopRequestSchema,
} from '../shared/control-plane-session.js';
import { withControlDORetry as withDORetry } from './diagnostics.js';
import { DEADLINE_MS } from './deadlines.js';
import { loadPhysicalRecord, loadRouteTable } from './durable-state.js';
import {
  recoveryAuthoritySchema,
  replaceRecoveryAuthority,
  type SandboxRecoveryDecision,
  type RecoveryAuthority,
  type RecoveryRoot,
  type RecoveryScopeResult,
} from './control-recovery.js';

function matchesControlStopRequest(
  receipt: ReturnType<typeof controlStopReceiptSchema.parse>,
  request: ReturnType<typeof controlStopRequestSchema.parse>
): boolean {
  return (
    receipt.version === request.version &&
    receipt.operationId === request.operationId &&
    receipt.cleanupDeadlineAt === request.cleanupDeadlineAt &&
    JSON.stringify(receipt.scope) === JSON.stringify(request.scope) &&
    JSON.stringify(receipt.targets) === JSON.stringify(request.targets)
  );
}

export function createRecoveryAuthority(input: {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;
  env: Env;
  sandboxId: string;
}) {
  return {
    async load(recovery: SandboxRecoveryDecision): Promise<RecoveryAuthority | undefined> {
      const [physical, routes] = await Promise.all([
        loadPhysicalRecord(input.storage),
        loadRouteTable(input.storage),
      ]);
      if (
        !physical.providerRef ||
        physical.providerRef !== recovery.providerInstanceId ||
        physical.state !== 'running' ||
        physical.stopTombstone !== null ||
        (recovery.authority &&
          recovery.authority.allocation.createIntentId !== physical.createIntent?.intentId)
      )
        return undefined;
      const scoped = await Promise.all(
        [...routes.values()].map(async route => {
          const recovered =
            recovery.activationAcknowledgedAt === undefined
              ? undefined
              : recovery.authority?.roots?.find(
                  root => root.sessionId === route.sessionId && root.decision === 'ready'
                );
          if (recovered)
            return {
              root: recovered,
              scopes:
                recovery.authority?.scopes.filter(scope => scope.sessionId === route.sessionId) ??
                [],
              stops: [],
            };
          const root: RecoveryRoot = {
            sessionId: route.sessionId,
            ownerId: route.ownerId,
            kiloSessionId: route.kiloSessionId,
            directory: route.directory,
            ...(route.nativeRuntimeId ? { nativeRuntimeId: route.nativeRuntimeId } : {}),
            observation: 'unknown',
            decision: 'operation_unknown',
          };
          const unknown = { root, scopes: [], stops: [] };
          try {
            const state = z
              .object(controlSessionStateSchema.shape)
              .strict()
              .nullable()
              .parse(
                await withTimeout(
                  withDORetry(
                    () => getSandboxSessionStub(input.env, route.ownerId, route.sessionId),
                    stub => stub.getControlState({ includeIdle: true }),
                    'getControlState'
                  ),
                  DEADLINE_MS.stopAttempt,
                  'Recovery session authority timed out'
                )
              );
            if (
              state === null ||
              state.scope.sandboxId !== input.sandboxId ||
              (state.scope.wrapperInstanceId !== undefined &&
                state.scope.wrapperInstanceId !== recovery.wrapperInstanceId)
            )
              return unknown;
            const targets = [
              ...state.targets,
              ...(state.stops ?? []).flatMap(stop => stop.targets),
            ];
            if (
              targets.some(
                target =>
                  target.wrapperInstanceId !== undefined &&
                  target.wrapperInstanceId !== recovery.wrapperInstanceId
              )
            )
              return unknown;
            return {
              root: {
                ...root,
                observation: targets.length === 0 ? ('idle' as const) : ('known' as const),
                observedAt: Date.now(),
                decision:
                  (state.stops?.length ?? 0) > 0
                    ? ('stop_pending' as const)
                    : targets.length > 0
                      ? ('operation_unknown' as const)
                      : ('ready' as const),
              },
              scopes: targets.map(target => {
                const operation = state.operations?.find(
                  current => current.messageId === target.messageId
                );
                const executionDeadlineAt =
                  operation?.executionDeadlineAt ?? target.executionDeadlineAt;
                return {
                  ...(operation &&
                  operation.authorization.wrapperInstanceId === target.wrapperInstanceId
                    ? { authorization: operation.authorization }
                    : {}),
                  sessionId: route.sessionId,
                  kiloSessionId: route.kiloSessionId,
                  directory: route.directory,
                  messageId: target.messageId,
                  ...(target.wrapperInstanceId
                    ? { wrapperInstanceId: target.wrapperInstanceId }
                    : {}),
                  ...(route.nativeRuntimeId ? { nativeRuntimeId: route.nativeRuntimeId } : {}),
                  ...(executionDeadlineAt ? { executionDeadlineAt } : {}),
                };
              }),
              stops: (state.stops ?? []).map(stop => ({
                sessionId: route.sessionId,
                ownerId: route.ownerId,
                request: controlStopRequestSchema.parse({
                  version: stop.version,
                  operationId: stop.operationId,
                  scope: stop.scope,
                  targets: stop.targets,
                  cleanupDeadlineAt: stop.cleanupDeadlineAt,
                }),
              })),
            };
          } catch {
            return unknown;
          }
        })
      );
      const authority = recoveryAuthoritySchema.parse({
        source: 'session_control_state',
        observedAt: Date.now(),
        allocation: {
          providerRef: physical.providerRef,
          ...(physical.createIntent ? { createIntentId: physical.createIntent.intentId } : {}),
        },
        roots: scoped.map(item => item.root),
        scopes: scoped.flatMap(item => item.scopes),
        stops: scoped.flatMap(item => item.stops),
        wholeAllocation: scoped.every(item => item.root.observation !== 'unknown'),
      });
      return replaceRecoveryAuthority(recovery, authority).authority;
    },
    async reconcileStops(authority: RecoveryAuthority): Promise<RecoveryScopeResult[]> {
      return Promise.all(
        (authority.roots ?? []).map(async root => {
          const stops = authority.stops.filter(stop => stop.sessionId === root.sessionId);
          const confirmed = await Promise.all(
            stops.map(async stop => {
              try {
                const receipt = controlStopReceiptSchema.parse(
                  await withTimeout(
                    withDORetry(
                      () => getSandboxSessionStub(input.env, stop.ownerId, stop.sessionId),
                      stub => stub.interruptExecution(stop.request),
                      'reconcileRecoveryStop'
                    ),
                    DEADLINE_MS.stopAttempt,
                    'Recovery Stop reconciliation timed out'
                  )
                );
                return (
                  receipt.state === 'confirmed' && matchesControlStopRequest(receipt, stop.request)
                );
              } catch {
                return false;
              }
            })
          );
          return {
            sessionId: root.sessionId,
            decision: confirmed.every(Boolean) ? 'ready' : 'stop_pending',
          };
        })
      );
    },
    async reconcileOperations(authority: RecoveryAuthority): Promise<RecoveryScopeResult[]> {
      const routes = await loadRouteTable(input.storage);
      return Promise.all(
        (authority.roots ?? []).map(async root => {
          const unknown: RecoveryScopeResult = {
            sessionId: root.sessionId,
            decision: 'operation_unknown',
          };
          if (root.decision === 'ready') return { sessionId: root.sessionId, decision: 'ready' };
          const route = routes.get(root.sessionId);
          if (
            !route ||
            route.ownerId !== root.ownerId ||
            route.kiloSessionId !== root.kiloSessionId ||
            route.directory !== root.directory ||
            route.nativeRuntimeId !== root.nativeRuntimeId ||
            root.observation === 'unknown' ||
            root.observation === 'stale'
          )
            return unknown;
          const scopes = authority.scopes.filter(scope => scope.sessionId === root.sessionId);
          if (
            scopes.some(
              scope =>
                scope.executionDeadlineAt !== undefined && scope.executionDeadlineAt <= Date.now()
            )
          )
            return { sessionId: root.sessionId, decision: 'execution_expired' };
          const authorizations = scopes.flatMap(scope =>
            scope.authorization ? [scope.authorization] : []
          );
          if (
            authorizations.some(
              auth =>
                auth.session.sessionId !== root.sessionId ||
                auth.session.kiloSessionId !== root.kiloSessionId ||
                auth.session.directory !== root.directory
            )
          )
            return unknown;
          if (scopes.length > 0 && authorizations.length === 0) return unknown;
          if (authorizations.length === 0) return { sessionId: root.sessionId, decision: 'ready' };
          try {
            const result = await withTimeout(
              withDORetry(
                () => getSandboxSessionStub(input.env, root.ownerId, root.sessionId),
                stub => stub.reconcileControlRecovery(authorizations),
                'reconcileRecoveryOperations'
              ),
              DEADLINE_MS.stopAttempt,
              'Recovery operation reconciliation timed out'
            );
            return result.state === 'reconciled'
              ? { sessionId: root.sessionId, decision: 'ready' }
              : unknown;
          } catch {
            return unknown;
          }
        })
      );
    },
  };
}
