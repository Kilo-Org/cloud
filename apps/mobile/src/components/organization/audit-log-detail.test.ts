/* eslint-disable max-lines -- one suite covers the whole audit-detail vocabulary: the coverage walk over every event id and the payload samples beside it belong with the assertions, so a new id cannot be proved in one file and forgotten in another. */
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
import { isolateBidiText, isolateLtrBidiText } from '@/lib/bidi';
import { formatList, formatNumber, formatPrefixedMoney } from '@/lib/format';
import { auditEntryDetail } from './audit-log-detail';

const t = i18n.t.bind(i18n);

/** The detail as the screen renders it, in one language. */
async function renderIn(language: string, detail: AuditDetail | null): Promise<string | undefined> {
  await i18n.changeLanguage(language);
  return auditEntryDetail(t, language, detail);
}

/**
 * One counted form as the shipped catalog writes it, with the count passed the
 * way the renderer passes it. The key names the plural category explicitly, so a
 * catalog missing that form fails here rather than falling back, and every
 * expectation comes from the catalogs through `i18n.t` instead of repeating a
 * translation.
 */
function form(
  language: string,
  key: string,
  values: { count: number } & Record<string, string | number>
) {
  const { count, ...rest } = values;
  return i18n.t(`organization.auditLog.detail.${key}`, {
    lng: language,
    count,
    displayCount: formatNumber(count, language),
    ...rest,
  });
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

  it('reads an old value then a new value in one left-to-right run', async () => {
    // A right-to-left paragraph lays an unisolated pair out right to left, so
    // the reader takes the new value for the old one. One left-to-right
    // isolate pins the order of the pair.
    const rendered = await renderIn('ar', {
      id: 'member.role',
      email: 'ada@example.com',
      previous: 'member',
      next: 'admin',
    });
    const oldRole = i18n.t('organization.auditLog.detail.role.member');
    const newRole = i18n.t('organization.auditLog.detail.role.admin');
    expect(rendered).toContain(isolateLtrBidiText(`${oldRole} → ${newRole}`));
    // Inside that run the logical order is the old value, then the arrow, then
    // the new value.
    const run = rendered?.slice(rendered.indexOf('\u2066')) ?? '';
    const oldAt = run.indexOf(oldRole);
    const arrowAt = run.indexOf(' → ');
    const newAt = run.indexOf(newRole);
    expect(oldAt).toBeGreaterThanOrEqual(0);
    expect(arrowAt).toBeGreaterThan(oldAt);
    expect(newAt).toBeGreaterThan(arrowAt);
    // Neither value keeps an isolate of its own inside the run.
    expect(run).not.toContain(isolateLtrBidiText(oldRole));
    expect(run).not.toContain(isolateLtrBidiText(newRole));
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

  it('states a key toggle only when the key itself was toggled', async () => {
    const toggled = await renderIn('ja', {
      id: 'integration.keyToggled',
      integration: 'byok',
      provider: 'anthropic',
      enabled: true,
    });
    expect(toggled).toContain('anthropic');

    // A catalog-model toggle carries a different fact, so it states none.
    expect(
      await renderIn('ja', {
        id: 'integration.keyToggled',
        integration: 'byok',
        provider: 'anthropic',
        enabled: true,
        catalogModels: true,
      })
    ).toBeUndefined();
  });

  it('renders no dangling arrow for a route that was only set or only cleared', async () => {
    expect(
      await renderIn('ja', { id: 'setting.autoRoute', mode: 'code', next: 'anthropic/x' })
    ).toBeUndefined();
    expect(
      await renderIn('ja', { id: 'setting.autoRoute', mode: 'code', previous: 'anthropic/x' })
    ).toBeUndefined();
    const moved = await renderIn('ja', {
      id: 'setting.autoRoute',
      mode: 'code',
      previous: 'anthropic/x',
      next: 'openai/y',
    });
    expect(moved).toContain('openai/y');
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

  it('states the allowed origins a browser-control save carried', async () => {
    const withOrigins = await renderIn('en', {
      id: 'setting.browserControl',
      policy: 'allow',
      origins: ['https://a.example', 'https://b.example'],
    });
    expect(withOrigins).toContain('https://a.example');
    expect(withOrigins).toContain('https://b.example');
    expect(withOrigins).toContain(i18n.t('organization.auditLog.detail.browserPolicyAllow'));

    // A row that carried no origins names the policy alone, as before.
    const policyOnly = await renderIn('en', { id: 'setting.browserControl', policy: 'allow' });
    expect(policyOnly).toBe(i18n.t('organization.auditLog.detail.browserPolicyAllow'));
  });

  it('reads a group member count through the groups screen plural family', async () => {
    const one = await renderIn('en', { id: 'group.members', name: 'Support', count: 1 });
    expect(one).toContain('1 member');
    expect(one).not.toContain('1 members');

    const many = await renderIn('en', { id: 'group.members', name: 'Support', count: 3 });
    expect(many).toContain('3 members');
  });

  // The row hands i18next the count and the reader's formatted number, so the
  // category comes from the language and the words from that catalog. English
  // ships one/other, Arabic few at 3 and many at 11, Polish few at 3 and many at
  // 5, and every expected sentence is that catalog's own form. Each row is its
  // own case because the shared instance changes language per render.
  const PLURAL_ROWS = [
    ['en', 1, 'one'],
    ['en', 2, 'other'],
    ['ar', 3, 'few'],
    ['ar', 11, 'many'],
    ['pl', 3, 'few'],
    ['pl', 5, 'many'],
  ] as const;

  it.each(PLURAL_ROWS)(
    'counts a group sentence in %s’s own plural category at %i',
    async (language, count, category) => {
      expect(await renderIn(language, { id: 'group.memberGroups', count })).toBe(
        form(language, `groupMemberGroups_${category}`, { count })
      );
      // The category the language selected is the one this row names, so a
      // family whose forms were all alike would still have to match the catalog.
      expect(new Intl.PluralRules(language).select(count)).toBe(category);
    }
  );

  it('reads a different sentence for every count the reader’s rules separate', () => {
    const sentences = new Set(
      PLURAL_ROWS.map(([language, count, category]) =>
        form(language, `groupMemberGroups_${category}`, { count })
      )
    );
    expect(sentences.size).toBe(PLURAL_ROWS.length);
  });

  it('counts the address line and the distributed amount through their families', async () => {
    // The row isolates the address itself and formats the amount itself, so the
    // expectation carries the isolate and the money shape the row produces.
    const email = 'ada@example.com';
    expect(await renderIn('en', { id: 'group.memberGroups', email, count: 1 })).toBe(
      form('en', 'groupMemberGroupsOf_one', { count: 1, email: isolateBidiText(email) })
    );
    const amount = formatPrefixedMoney(10, 'en');
    expect(await renderIn('en', { id: 'funds.distributed', amount: 10, count: 1 })).toBe(
      form('en', 'fundsDistributed_one', { count: 1, amount })
    );
    expect(await renderIn('en', { id: 'funds.distributed', amount: 10, count: 4 })).toBe(
      form('en', 'fundsDistributed_other', { count: 4, amount })
    );
  });

  it('counts both clauses of a rotation, each in its own plural form', async () => {
    // Two counts in one row, and i18next resolves a form from one count per key,
    // so each count is its own family and the row joins their sentences.
    const rendered = await renderIn('en', {
      id: 'reviewAgent.secretRotated',
      updated: 1,
      errors: 2,
    });
    const updated = form('en', 'reviewAgentSecretsUpdated_one', { count: 1 });
    const failed = form('en', 'reviewAgentSecretsFailed_other', { count: 2 });
    expect(rendered).toBe(formatList([updated, failed], 'en'));
    // Neither count renders its sibling's sentence.
    expect(updated).not.toBe(form('en', 'reviewAgentSecretsUpdated_other', { count: 3 }));
    expect(failed).not.toBe(form('en', 'reviewAgentSecretsFailed_one', { count: 1 }));
  });

  it('has a template for every event id the shared contract defines', () => {
    // The renderer's table is keyed by `AuditDetail['id']`, so an entry that is
    // misspelled or typed against another member fails the type check. Entries
    // are optional — some ids render no sentence — so this test is what proves
    // every id is classified: each id either renders a line or is one of the
    // ids that deliberately does not.
    // Ids whose own event name already states the event, and ids whose one
    // sentence needs a value this sample does not carry (a set or a clear has
    // only one arm, a removed link has no policy to name, and a catalog-model
    // toggle is not the key's own state).
    const deliberatelyBare = new Set<string>([
      'setting.accessLists',
      'setting.byokPriorities',
      'token.user',
      'token.resource',
      'namedPolicy.linked',
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
    'setting.autoRoute': { id: 'setting.autoRoute', mode: 'code', previous: 'a', next: 'b' },
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
    'setting.browserControl': {
      id: 'setting.browserControl',
      policy: 'allow',
      origins: ['https://example.test'],
    },
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
