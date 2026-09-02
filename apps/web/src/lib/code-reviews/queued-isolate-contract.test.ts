import type { z } from 'zod';
import * as contracts from './queued-isolate-contract';

const worker: Record<string, z.ZodType> = jest.requireActual(
  '../../../../../services/isolate-review/src/types'
);
const identity: contracts.QueuedIsolateIdentity = {
  reviewId: '21737409-c62b-4e5b-854a-0b32bec88919',
  attemptId: 'd94bcb62-aac1-4e61-96e8-44912501737e',
  generation: '85c26775-d3a4-461f-8c94-ade923a49685',
  organizationId: '9fd6b5ea-a25e-42e6-bf40-1b5e73e0bc89',
  integrationId: 'cc505af3-3a9b-4e24-8cd1-34cd78534df5',
  executionUserId: 'oauth/github/arbitrary-user-id',
  target: { host: 'github.com', repoFullName: 'kilo/repo', prNumber: 12 },
  snapshot: { headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) },
};
const safety: contracts.QueuedIsolateSafety = {
  sequence: 1,
  execution: 'cancelled',
  cancellationRequested: true,
  publication: 'uncertain',
  quiescent: false,
  observedAt: '2026-04-29T01:16:12.945Z',
};

const schemas = [contracts, worker];

describe.each(schemas.map((schema, index) => [index === 0 ? 'web' : 'worker', schema] as const))(
  '%s queued protocol',
  (_name, schema) => {
    it('binds one run to the attempt and full canonical identity', () => {
      const admission = {
        version: 1,
        runId: identity.attemptId,
        identity,
        preparationHash: 'f'.repeat(64),
      };
      expect(schema.QueuedIsolateAdmissionSchema.parse(admission)).toEqual(admission);
      expect(
        schema.QueuedIsolateAdmissionSchema.safeParse({ ...admission, runId: identity.reviewId })
          .success
      ).toBe(false);
      expect(
        schema.QueuedIsolateIdentitySchema.safeParse({
          ...identity,
          callbackUrl: 'https://example.com',
        }).success
      ).toBe(false);
      expect(
        schema.QueuedIsolateIdentitySchema.safeParse({ ...identity, executionUserId: '' }).success
      ).toBe(false);
      expect(
        schema.QueuedIsolateIdentitySchema.safeParse({
          ...identity,
          executionUserId: 'x'.repeat(257),
        }).success
      ).toBe(false);
      expect(
        schema.QueuedIsolateIdentitySchema.safeParse({ ...identity, organizationId: 'oauth/user' })
          .success
      ).toBe(false);
      expect(
        schema.QueuedIsolateIdentitySchema.safeParse({
          ...identity,
          snapshot: { ...identity.snapshot, headSha: 'short' },
        }).success
      ).toBe(false);
    });

    it('keeps cancellation, execution, publication and quiescence separate', () => {
      expect(schema.QueuedIsolateSafetySchema.parse(safety)).toEqual(safety);
      for (const execution of ['not_started', 'running', 'completed', 'failed', 'cancelled']) {
        expect(
          schema.QueuedIsolateSafetySchema.safeParse({ ...safety, execution, quiescent: true })
            .success
        ).toBe(false);
      }
      expect(
        schema.QueuedIsolateSafetySchema.safeParse({
          ...safety,
          publication: 'settled',
          quiescent: true,
        }).success
      ).toBe(true);
      expect(
        schema.QueuedIsolateSafetySchema.safeParse({
          ...safety,
          publication: 'not_started',
          quiescent: true,
        }).success
      ).toBe(true);
      expect(
        schema.QueuedIsolateSafetySchema.safeParse({ ...safety, quiescent: 'true' }).success
      ).toBe(false);
      for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(schema.QueuedIsolateSafetySchema.safeParse({ ...safety, sequence }).success).toBe(
          false
        );
      }
    });

    it('requires explicit scoped authority and distinguishes acknowledgement from release', () => {
      const request = {
        version: 1,
        identity,
        operation: 'publish',
        operationId: identity.generation,
        preparationHash: 'f'.repeat(64),
      };
      expect(schema.QueuedIsolateAuthorityRequestSchema.parse(request)).toEqual(request);
      expect(schema.QueuedIsolateAuthorityResponseSchema.safeParse(request).success).toBe(false);
      expect(
        schema.QueuedIsolateAuthorityResponseSchema.safeParse({ ...request, authorized: 'true' })
          .success
      ).toBe(false);
      expect(
        schema.QueuedIsolateAuthorityResponseSchema.safeParse({ ...request, authorized: false })
          .success
      ).toBe(true);
      const acknowledgement = {
        version: 1,
        identity,
        sequence: 1,
        notificationRecorded: true,
        fenceReleased: false,
        usageSettled: false,
      };
      expect(schema.QueuedIsolateAcknowledgementSchema.parse(acknowledgement)).toEqual(
        acknowledgement
      );
      expect(
        schema.QueuedIsolateAcknowledgementSchema.parse({
          ...acknowledgement,
          fenceReleased: true,
          usageSettled: undefined,
        })
      ).toMatchObject({ usageSettled: false });
      expect(
        schema.QueuedIsolateAcknowledgementSchema.safeParse({
          ...acknowledgement,
          usageSettled: 'true',
        }).success
      ).toBe(false);
      expect(
        schema.QueuedIsolateAcknowledgementSchema.safeParse({
          ...acknowledgement,
          notificationRecorded: false,
        }).success
      ).toBe(false);
      expect(
        schema.QueuedIsolateControlRequestSchema.safeParse({
          version: 1,
          identity,
          operation: 'cancel',
        }).success
      ).toBe(true);
      expect(
        schema.QueuedIsolateControlRequestSchema.safeParse({
          version: 1,
          identity,
          operation: 'execute',
        }).success
      ).toBe(false);
    });

    it('requires bounded terminal evidence, exact root and ordered child session references', () => {
      const result = {
        reason: 'cancelled',
        completedAt: safety.observedAt,
        sessions: [{ sessionId: identity.attemptId, parentSessionId: null }],
        summary: null,
        gateResult: null,
        analytics: { marker: null, omitted: false },
      };
      const notification = { version: 1, identity, safety, result };
      expect(schema.QueuedIsolateNotificationSchema.parse(notification)).toEqual(notification);
      for (const requestCount of [-1, 1.5, 1_001, '1', null]) {
        expect(
          schema.QueuedIsolateNotificationSchema.safeParse({
            ...notification,
            result: { ...result, sessions: [{ ...result.sessions[0], requestCount }] },
          }).success
        ).toBe(false);
      }
      for (const requestCount of [0, 1, 1_000]) {
        expect(
          schema.QueuedIsolateNotificationSchema.safeParse({
            ...notification,
            result: { ...result, sessions: [{ ...result.sessions[0], requestCount }] },
          }).success
        ).toBe(true);
      }
      for (const changed of [
        { ...notification, result: undefined },
        { ...notification, safety: { ...safety, execution: 'running' } },
        { ...notification, result: { ...result, reason: 'completed' } },
        { ...notification, result: { ...result, sessions: [] } },
        {
          ...notification,
          result: { ...result, sessions: [...result.sessions, result.sessions[0]] },
        },
        {
          ...notification,
          result: {
            ...result,
            sessions: [{ sessionId: identity.generation, parentSessionId: null }],
          },
        },
        {
          ...notification,
          result: {
            ...result,
            sessions: [
              ...result.sessions,
              { sessionId: identity.generation, parentSessionId: identity.reviewId },
            ],
          },
        },
        {
          ...notification,
          result: { ...result, analytics: { marker: '界'.repeat(6_000), omitted: false } },
        },
        { ...notification, result: { ...result, arbitraryCredentials: 'rejected' } },
      ])
        expect(schema.QueuedIsolateNotificationSchema.safeParse(changed).success).toBe(false);
      const children = {
        ...notification,
        result: {
          ...result,
          sessions: [
            ...result.sessions,
            { sessionId: identity.generation, parentSessionId: identity.attemptId },
            { sessionId: identity.reviewId, parentSessionId: identity.generation },
          ],
        },
      };
      expect(schema.QueuedIsolateNotificationSchema.parse(children)).toEqual(children);
      const reconcile = {
        version: 1,
        identity,
        operation: 'reconcile',
        operationId: identity.generation,
        preparationHash: 'f'.repeat(64),
        authorized: true,
      };
      expect(schema.QueuedIsolateAuthorityResponseSchema.safeParse(reconcile).success).toBe(false);
      expect(
        schema.QueuedIsolateAuthorityResponseSchema.safeParse({
          ...reconcile,
          reconciliationUserId: 'bot-fixture',
        }).success
      ).toBe(true);
      expect(
        schema.QueuedIsolateAuthorityResponseSchema.safeParse({
          ...reconcile,
          operation: 'execute',
          reconciliationUserId: 'bot-fixture',
        }).success
      ).toBe(false);
    });

    it.each(['byok_invalid_key', 'selected_model_unavailable'])(
      'carries only allowlisted provider failure reasons through failed terminal evidence: %s',
      reason => {
        const notification = {
          version: 1,
          identity,
          safety: { ...safety, execution: 'failed', cancellationRequested: false },
          result: {
            reason,
            completedAt: safety.observedAt,
            sessions: [{ sessionId: identity.attemptId, parentSessionId: null, requestCount: 1 }],
            summary: null,
            gateResult: null,
            analytics: { marker: null, omitted: false },
          },
        };
        expect(schema.QueuedIsolateNotificationSchema.parse(notification)).toEqual(notification);
        for (const execution of ['completed', 'cancelled']) {
          expect(
            schema.QueuedIsolateNotificationSchema.safeParse({
              ...notification,
              safety: { ...notification.safety, execution },
            }).success
          ).toBe(false);
        }
        for (const result of [
          { ...notification.result, reason: `${reason}: private-provider-detail` },
          { ...notification.result, errorMessage: 'private-provider-detail' },
          { ...notification.result, reason: 'provider_authentication' },
          { ...notification.result, reason: 'github_installation_required' },
        ]) {
          expect(
            schema.QueuedIsolateNotificationSchema.safeParse({ ...notification, result }).success
          ).toBe(false);
        }
      }
    );

    it('accepts only canonical bounded GitHub publication targets', () => {
      for (const target of [
        { ...identity.target, host: 'gitlab.com' },
        { ...identity.target, repoFullName: 'Kilo/Repo' },
        { ...identity.target, repoFullName: 'https://github.com/kilo/repo' },
        { ...identity.target, repoFullName: 'org/repo/extra' },
        { ...identity.target, prNumber: 0 },
        { ...identity.target, prNumber: 2_147_483_648 },
      ]) {
        expect(schema.GithubPublicationTargetSchema.safeParse(target).success).toBe(false);
      }
    });
  }
);

it('distinguishes incomplete billing settlement from complete totals', () => {
  const totals = { tokensIn: 10, tokensOut: 2, cacheHit: 0, cacheWrite: 0, cost: 100 };
  const incomplete = { totals: null, unavailableReason: 'billing_incomplete' };
  expect(contracts.QueuedIsolateUsageSettlementSchema.parse(incomplete)).toEqual(incomplete);
  expect(contracts.QueuedIsolateUsageSettlementSchema.parse({ totals })).toEqual({ totals });
  expect(contracts.QueuedIsolateUsageSettlementSchema.parse({ totals: null })).toEqual({
    totals: null,
  });
  expect(
    contracts.QueuedIsolateUsageSettlementSchema.safeParse({ ...incomplete, totals }).success
  ).toBe(false);
  expect(
    contracts.QueuedIsolateUsageSettlementSchema.safeParse({
      ...incomplete,
      unavailableReason: 'timeout',
    }).success
  ).toBe(false);
});

it('normalizes PostgreSQL timestamps before a strict protocol boundary', () => {
  const stored = { ...safety, observedAt: '2026-04-29 01:16:12.945+00' };
  expect(contracts.QueuedIsolateSafetySchema.safeParse(stored).success).toBe(false);
  expect(contracts.serializeQueuedIsolateSafety(stored)).toEqual(safety);
});

it('normalizes repository casing without widening host or path scope', () => {
  expect(contracts.githubPublicationTarget('Kilo/Repo', 12)).toEqual(identity.target);
  expect(() => contracts.githubPublicationTarget(' Kilo/Repo ', 12)).toThrow();
});

it('compares every authority dimension independently', () => {
  expect(contracts.sameQueuedIsolateIdentity(identity, structuredClone(identity))).toBe(true);
  const variants = [
    ...[
      'reviewId',
      'attemptId',
      'generation',
      'organizationId',
      'integrationId',
      'executionUserId',
    ].map(key => ({ ...identity, [key]: 'different' })),
    { ...identity, target: { ...identity.target, repoFullName: 'other/repo' } },
    { ...identity, target: { ...identity.target, prNumber: 13 } },
    ...['headSha', 'baseTipSha', 'mergeBaseSha'].map(key => ({
      ...identity,
      snapshot: { ...identity.snapshot, [key]: 'd'.repeat(40) },
    })),
  ];
  for (const variant of variants)
    expect(contracts.sameQueuedIsolateIdentity(identity, variant)).toBe(false);
});
