import { describe, expect, test } from '@jest/globals';
import {
  ADMIN_STEP_UP_ABSENT,
  createAdminAssurance,
  deriveCredentialKind,
  describePrivilegedAction,
  type PrivilegedActor,
} from './privileged-access';

describe('credential provenance', () => {
  test('classifies a request without Authorization as session', () => {
    expect(deriveCredentialKind({ authViaToken: false })).toBe('session');
  });

  test('classifies a personal bearer key as human_bearer', () => {
    expect(deriveCredentialKind({ authViaToken: true })).toBe('human_bearer');
    expect(deriveCredentialKind({ authViaToken: true, tokenSource: 'personal' })).toBe(
      'human_bearer'
    );
  });

  test('classifies delegated workload tokens by source or scoped authority', () => {
    expect(deriveCredentialKind({ authViaToken: true, tokenSource: 'cloud-agent' })).toBe(
      'delegated_workload'
    );
    expect(deriveCredentialKind({ authViaToken: true, delegatedWorkload: true })).toBe(
      'delegated_workload'
    );
  });

  test('classifies internal-service and attested requests as service assertions', () => {
    expect(deriveCredentialKind({ authViaToken: true, internalApiUse: true })).toBe(
      'service_assertion'
    );
    expect(deriveCredentialKind({ authViaToken: true, serviceAssertion: true })).toBe(
      'service_assertion'
    );
  });
});

describe('AdminAssurance', () => {
  test('has explicit permissions, an absent step-up, and a null support-grant slot', () => {
    const actor: PrivilegedActor = {
      assurance: createAdminAssurance({
        userId: 'user-1',
        permissions: {
          isAdmin: true,
          isSuperAdmin: false,
          canViewSessions: false,
          canManageCredits: true,
          canExportApiRequestLogs: false,
        },
      }),
      credential: 'human_bearer',
      tokenSource: null,
      action: describePrivilegedAction('sensitive_write', { kind: 'user', id: 'user-2' }, 'x'),
    };

    expect(actor.assurance.stepUp).toBe(ADMIN_STEP_UP_ABSENT);
    expect(actor.assurance.supportGrant).toBeNull();
    expect(actor.assurance.permissions).toEqual({
      isAdmin: true,
      isSuperAdmin: false,
      canViewSessions: false,
      canManageCredits: true,
      canExportApiRequestLogs: false,
    });
    expect(actor.action.actionClass).toBe('sensitive_write');
    expect(actor.action.inventoryId).toBe('x');
  });
});
