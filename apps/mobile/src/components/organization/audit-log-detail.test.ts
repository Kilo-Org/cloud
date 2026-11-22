// The detail line's contract: a stored event renders in the reader's language,
// never as the server's English sentence; a value the reader compares stays in
// its own direction; and a row with no structured event, or an event whose name
// already says everything, renders no detail at all.
//
// The renderer is pure, so the suite drives it directly with a real i18next
// instance loaded from the shipped catalogs. That is what makes a Japanese row
// provable without a device: the same template and the same values the screen
// interpolates.

import { afterEach, describe, expect, it } from 'vitest';

import { AUDIT_DETAIL_IDS, type AuditDetail } from '@kilocode/app-shared/organizations';

import { i18n } from '@/i18n';
import { auditEntryDetail } from './audit-log-detail';

const t = i18n.t.bind(i18n);

/** The detail as the screen renders it, in one language. */
async function renderIn(language: string, detail: AuditDetail | null): Promise<string | undefined> {
  await i18n.changeLanguage(language);
  return auditEntryDetail(t, language, detail);
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('auditEntryDetail', () => {
  it('names a mode and its identifier, and states the changed fields', async () => {
    expect(
      await renderIn('ja', { id: 'mode.identity', name: 'カスタマーサポート', slug: 'mode' })
    ).toContain('カスタマーサポート');

    const update = await renderIn('ja', {
      id: 'mode.update',
      name: 'カスタマーサポート',
      slug: 'support-draft',
      fields: [{ field: 'slug', previous: 'mode', next: 'support-draft' }],
    });
    expect(update).toContain('support-draft');
    expect(update).toContain('mode');
    // The field's own label comes from the catalog, not from the server.
    expect(update).toContain(i18n.t('organization.auditLog.detail.field.slug'));
  });

  it('never renders the stored English message, only the template', async () => {
    const rendered = await renderIn('ja', { id: 'member.removed', email: 'ada@example.com' });
    expect(rendered).toContain('ada@example.com');
    expect(rendered).not.toContain('Removed');
  });

  it('renders a role through the catalog, not as the stored tag', async () => {
    const rendered = await renderIn('ja', {
      id: 'member.role',
      email: 'ada@example.com',
      previous: 'member',
      next: 'admin',
    });
    expect(rendered).toContain(i18n.t('organization.auditLog.detail.role.admin'));
    expect(rendered).not.toContain('billing_manager');
  });

  it('keeps a value that can carry its own direction inside an isolate', async () => {
    const rendered = await renderIn('ar', { id: 'member.removed', email: 'ada@example.com' });
    expect(rendered).toContain('\u2068ada@example.com\u2069');
  });

  it('renders no detail for an event whose name already says everything', () => {
    const bare: AuditDetail[] = [
      { id: 'setting.accessLists' },
      { id: 'setting.byokPriorities' },
      { id: 'token.user' },
      { id: 'token.resource' },
      { id: 'setting.minimumBalanceAlert', enabled: false },
    ];
    for (const detail of bare) {
      expect(auditEntryDetail(t, 'en', detail)).toBeUndefined();
    }
  });

  it('renders no detail for a row written before the column existed', () => {
    expect(auditEntryDetail(t, 'en', null)).toBeUndefined();
    expect(auditEntryDetail(t, 'en', undefined)).toBeUndefined();
  });

  it('renders no detail for a stored payload this build does not understand', () => {
    // A newer server wrote a member this build has no template for.
    expect(auditEntryDetail(t, 'en', { id: 'future.event' })).toBeUndefined();
    // A payload with a member's id but a field it does not carry.
    expect(auditEntryDetail(t, 'en', { id: 'member.removed' })).toBeUndefined();
  });

  it('names both advanced policies when one row recorded both', async () => {
    const both = await renderIn('ja', {
      id: 'setting.advancedPolicies',
      openRouter: false,
      region: 'jp',
    });
    expect(both).toContain(i18n.t('organization.auditLog.detail.region.jp'));
    // `openRouter: false` is the policy being off, so the row states that.
    expect(both).toContain(i18n.t('organization.auditLog.detail.disabled'));

    const regionOnly = await renderIn('ja', { id: 'setting.advancedPolicies', region: 'au' });
    expect(regionOnly).toContain(i18n.t('organization.auditLog.detail.region.au'));
    expect(regionOnly).not.toContain(i18n.t('organization.auditLog.detail.enabled'));
  });

  it('has a template for every event id the shared contract defines', () => {
    // The renderer's map is keyed by `AuditDetail['id']`, so a union member
    // without a case fails the type check. This asserts the runtime half: each
    // id either renders a line or is one of the ids that deliberately does not.
    const deliberatelyBare = new Set<string>([
      'setting.accessLists',
      'setting.byokPriorities',
      'token.user',
      'token.resource',
    ]);
    const samples = detailSample();
    for (const id of AUDIT_DETAIL_IDS) {
      const sample = samples[id];
      expect(sample, `no sample payload for ${id}`).toBeDefined();
      const rendered = auditEntryDetail(t, 'en', sample);
      if (deliberatelyBare.has(id)) {
        expect(rendered).toBeUndefined();
      } else {
        expect(typeof rendered, `${id} rendered no line`).toBe('string');
      }
    }
  });
});

/**
 * One payload per event id, so the coverage test above can walk the union
 * without a device. Every value is neutral test data.
 */
function detailSample(): Record<string, AuditDetail> {
  return {
    'mode.identity': { id: 'mode.identity', name: 'Support', slug: 'support' },
    'mode.update': {
      id: 'mode.update',
      name: 'Support',
      slug: 'support-draft',
      fields: [{ field: 'slug', previous: 'support', next: 'support-draft' }],
    },
    'member.role': { id: 'member.role', email: 'a@b.test', previous: 'member', next: 'admin' },
    'member.added': { id: 'member.added', email: 'a@b.test', role: 'admin' },
    'member.removed': { id: 'member.removed', email: 'a@b.test' },
    'member.parentAdded': { id: 'member.parentAdded', email: 'a@b.test', parent: 'Parent' },
    'member.parentRemoved': { id: 'member.parentRemoved', email: 'a@b.test', parent: 'Parent' },
    'invite.sent': { id: 'invite.sent', email: 'a@b.test', role: 'member' },
    'invite.revoked': { id: 'invite.revoked', email: 'a@b.test' },
    'invite.accepted': { id: 'invite.accepted', email: 'a@b.test' },
    'group.identity': { id: 'group.identity', name: 'Group' },
    'group.members': { id: 'group.members', name: 'Group', count: 2 },
    'group.memberGroups': { id: 'group.memberGroups', count: 2 },
    'group.policySet': { id: 'group.policySet', name: 'Group', policyType: 'code' },
    'group.policyRemoved': { id: 'group.policyRemoved', name: 'Group', policyType: 'code' },
    'group.defaultPolicySet': { id: 'group.defaultPolicySet', policyType: 'code' },
    'group.defaultPolicyRemoved': { id: 'group.defaultPolicyRemoved', policyType: 'code' },
    'guardrail.identity': { id: 'guardrail.identity', type: 'skill', name: 'Scan' },
    'guardrail.status': { id: 'guardrail.status', type: 'skill', name: 'Scan', enabled: true },
    'guardrail.config': { id: 'guardrail.config', enabled: true },
    'guardrail.enforcement': { id: 'guardrail.enforcement', target: 'mcp', enforcement: 'on' },
    'sso.domainSet': { id: 'sso.domainSet', domain: 'example.test' },
    'sso.domainRemoved': { id: 'sso.domainRemoved', domain: 'example.test' },
    'funds.purchased': { id: 'funds.purchased', amount: 10, method: 'card' },
    'funds.granted': { id: 'funds.granted', amount: 10 },
    'funds.distributed': { id: 'funds.distributed', amount: 10, count: 2 },
    'funds.received': { id: 'funds.received', amount: 10, parent: 'Parent' },
    'reviewAgent.platform': { id: 'reviewAgent.platform', platform: 'github' },
    'reviewAgent.config': { id: 'reviewAgent.config', platform: 'github', style: 'strict' },
    'reviewAgent.secretRotated': { id: 'reviewAgent.secretRotated', updated: 1, errors: 0 },
    'setting.advancedPolicies': {
      id: 'setting.advancedPolicies',
      openRouter: true,
      region: 'us',
    },
    'setting.defaultModel': { id: 'setting.defaultModel', previous: 'a', next: 'b' },
    'setting.autoRoute': { id: 'setting.autoRoute', mode: 'code', next: 'b' },
    'setting.defaultBehavior': { id: 'setting.defaultBehavior', behavior: 'global' },
    'setting.dataCollection': { id: 'setting.dataCollection', mode: 'allowed' },
    'setting.projectsUi': { id: 'setting.projectsUi', enabled: true },
    'setting.minimumBalanceAlert': {
      id: 'setting.minimumBalanceAlert',
      enabled: true,
      threshold: 10,
      emails: ['a@b.test'],
    },
    'setting.recommendationsDigest': { id: 'setting.recommendationsDigest', enabled: true },
    'setting.browserControl': { id: 'setting.browserControl', policy: 'allow' },
    'setting.accessLists': { id: 'setting.accessLists' },
    'setting.name': { id: 'setting.name', previous: 'A', next: 'B' },
    'setting.byokPriorities': { id: 'setting.byokPriorities' },
    'integration.connected': { id: 'integration.connected', integration: 'slack' },
    'integration.disconnected': { id: 'integration.disconnected', integration: 'linear' },
    'integration.modelUpdated': {
      id: 'integration.modelUpdated',
      integration: 'discord',
      model: 'm',
    },
    'integration.installed': { id: 'integration.installed', integration: 'github' },
    'integration.uninstalled': { id: 'integration.uninstalled', integration: 'github' },
    'integration.refreshed': { id: 'integration.refreshed', integration: 'github' },
    'integration.cancelled': { id: 'integration.cancelled', integration: 'github' },
    'integration.keyAdded': { id: 'integration.keyAdded', integration: 'byok', provider: 'p' },
    'integration.keyUpdated': { id: 'integration.keyUpdated', integration: 'byok', provider: 'p' },
    'integration.keyDeleted': { id: 'integration.keyDeleted', integration: 'byok', provider: 'p' },
    'integration.keyToggled': {
      id: 'integration.keyToggled',
      integration: 'byok',
      provider: 'p',
      enabled: true,
    },
    'autoRouting.models': { id: 'autoRouting.models', added: [], removed: ['m'] },
    'namedPolicy.created': { id: 'namedPolicy.created', policyKind: 'code', policyId: '1' },
    'namedPolicy.updated': { id: 'namedPolicy.updated', policyKind: 'code', policyId: '1' },
    'namedPolicy.deleted': { id: 'namedPolicy.deleted', policyKind: 'code', policyId: '1' },
    'namedPolicy.linked': { id: 'namedPolicy.linked', policyKind: 'code', scope: 'default' },
    'webhookTrigger.updated': { id: 'webhookTrigger.updated', trigger: 't' },
    'token.user': { id: 'token.user' },
    'token.resource': { id: 'token.resource' },
    'organization.renamed': { id: 'organization.renamed', previous: 'A', next: 'B' },
  };
}
