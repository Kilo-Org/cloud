import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type SharePayload } from '@/lib/share-payload';

import {
  type OrganizationPlanState,
  remoteSpawnFilesNotSupportedToast,
  resolveRemoteSpawnAdmission,
  resolveRemoteStartPlan,
  startPlanRefusal,
} from './remote-spawn-admission';

const instance: InstancePickerInstance = {
  connectionId: 'conn-1',
  name: 'CLI',
  projectName: 'project',
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};

const filesPayload: SharePayload = {
  text: '',
  files: [
    { name: 'report.pdf', uri: 'file:///tmp/report.pdf', mimeType: 'application/pdf', size: 1024 },
  ],
  failedFiles: [],
};

const lapsed: OrganizationPlanState[] = [
  { organizationId: 'org-1', isTrialExpiredForEnforcement: true },
];
const entitled: OrganizationPlanState[] = [
  { organizationId: 'org-1', isTrialExpiredForEnforcement: false },
];

describe('resolveRemoteSpawnAdmission', () => {
  it('rejects files for an explicitly incapable instance', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance: { ...instance, capabilities: { attachments: false } },
        payload: filesPayload,
      })
    ).toEqual({ allowed: false, toast: remoteSpawnFilesNotSupportedToast() });
  });

  it('admits files when the capability is unknown (optimistic default)', () => {
    expect(resolveRemoteSpawnAdmission({ instance, payload: filesPayload })).toEqual({
      allowed: true,
    });
  });

  it('admits files when capability is explicitly true', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance: { ...instance, capabilities: { attachments: true } },
        payload: filesPayload,
      })
    ).toEqual({ allowed: true });
  });

  it('admits a null payload without capability', () => {
    expect(resolveRemoteSpawnAdmission({ instance, payload: null })).toEqual({
      allowed: true,
    });
  });

  it('admits a text-only payload without capability', () => {
    const textOnly: SharePayload = { text: 'hello', files: [], failedFiles: [] };
    expect(resolveRemoteSpawnAdmission({ instance, payload: textOnly })).toEqual({
      allowed: true,
    });
  });

  it('refuses a start in an organization whose trial lapsed, before any other check', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance: { ...instance, capabilities: { attachments: false } },
        payload: filesPayload,
        plan: { organizationId: 'org-1', organizations: lapsed },
      })
    ).toEqual({ allowed: false, toast: i18n.t('common.organizationTrialEnded') });
  });

  it('admits a start in an organization the gate keeps entitled', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance,
        payload: null,
        plan: { organizationId: 'org-1', organizations: entitled },
      })
    ).toEqual({ allowed: true });
  });

  it('admits a start in an organization the list does not hold', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance,
        payload: null,
        plan: { organizationId: 'org-2', organizations: lapsed },
      })
    ).toEqual({ allowed: true });
  });

  it('admits a personal start even when another membership lapsed', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance,
        payload: null,
        plan: { organizationId: null, organizations: lapsed },
      })
    ).toEqual({ allowed: true });
  });
});

describe('resolveRemoteStartPlan', () => {
  it('refuses with the organization trial explanation for a lapsed organization', () => {
    expect(resolveRemoteStartPlan({ organizationId: 'org-1', organizations: lapsed })).toEqual({
      allowed: false,
      toast: i18n.t('common.organizationTrialEnded'),
    });
  });

  it('admits an entitled organization', () => {
    expect(resolveRemoteStartPlan({ organizationId: 'org-1', organizations: entitled })).toEqual({
      allowed: true,
    });
  });

  it('admits on an unsettled membership list', () => {
    expect(resolveRemoteStartPlan({ organizationId: 'org-1', organizations: undefined })).toEqual({
      allowed: true,
    });
  });

  it('admits a personal start', () => {
    expect(resolveRemoteStartPlan({ organizationId: null, organizations: lapsed })).toEqual({
      allowed: true,
    });
  });
});

describe('startPlanRefusal', () => {
  it('explains a start under a lapsed organization before any press', () => {
    expect(startPlanRefusal({ organizationId: 'org-1', organizations: lapsed })).toBe(
      i18n.t('common.organizationTrialEnded')
    );
  });

  it('leaves an entitled organization, a personal start and an unsettled list alone', () => {
    expect(startPlanRefusal({ organizationId: 'org-1', organizations: entitled })).toBeNull();
    expect(startPlanRefusal({ organizationId: null, organizations: lapsed })).toBeNull();
    expect(startPlanRefusal({ organizationId: 'org-1', organizations: undefined })).toBeNull();
    expect(startPlanRefusal({ organizationId: 'org-2', organizations: lapsed })).toBeNull();
  });
});
