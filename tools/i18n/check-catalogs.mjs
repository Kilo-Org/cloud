#!/usr/bin/env node
/**
 * Catalog parity check.
 *
 * Every translated catalog must be a key-for-key copy of the English one, and
 * every key the source uses must exist. This runs in CI, so a locale can never
 * drift from English without the build saying so.
 *
 * Two catalogs share the audit: the mobile app's copy, read against
 * `apps/mobile/src`, and the notifications push copy, read against
 * `packages/notifications/src` and `services`. Each catalog is read against its
 * own source roots and its own translate call, so a key is judged used, or
 * missing, by the code that actually renders it.
 *
 * The value checks are mechanical, so they hold for a language nobody here
 * reads: placeholders, `$t(key)` references, edge spacing, double spaces and
 * direction marks must match English, and a message must never quote an
 * English button label in place of the reader's own.
 *
 * Usage: node tools/i18n/check-catalogs.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTranslateCallee, propertyName, stringLiteralValue, unwrap, walk } from '../lib/ast.mjs';
import {
  catalogEntryNames,
  catalogTags,
  countPlaceholderBases,
  flattenCatalog,
  missingPluralCategories,
  pluralFamilyBases,
  pluralParts,
  selectablePluralCategories,
  unselectablePluralCategories,
} from '../lib/catalogs.mjs';
import { runIfMain } from '../lib/entry-point.mjs';
import { isTestArtifact, parseSourceEntry, parseSourceTree } from '../lib/source-files.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The two catalogs the audit compares against their English files, with the
 * source trees whose calls and literals name their keys. The mobile app reads
 * its own tree; the push catalog is rendered on both sides of the wire, from
 * `packages/notifications/src` and from the workers under `services`.
 *
 * Each entry also carries the catalog's own policy. `baseKeyOf` names how a
 * consumer appends its part to a key. `englishCopyRules` lists the checks the
 * catalog's English copy must pass. `localeRegistry` names a hand-written
 * module the push runtime reads its catalogs from. `calledKeyOf` reads the key
 * one translate call names, `keyPrefixOf` the static head of a key built as a
 * template literal (null when the catalog builds none), and
 * `collectsDestructiveKeys` whether the scan gathers the keys object literals
 * paint on destructive buttons.
 */
function catalogsOf(root) {
  return [
    {
      name: 'mobile',
      dir: join(root, 'apps/mobile/src/i18n/locales'),
      sourceRoots: [join(root, 'apps/mobile/src')],
      baseKeyOf: pluralBaseKey,
      // The app renders on Hermes, which has no `Intl.PluralRules`, so the
      // FormatJS polyfill data the bundle ships decides the suffix.
      selectableCategoriesOf: tag => selectablePluralCategories(root, tag),
      englishCopyRules: [
        checkEnglishCopies,
        checkMobileEnglishIdentical,
        checkMobileLocaleEnglishCopy,
      ],
      calledKeyOf: mobileCalledKey,
      keyPrefixOf: null,
      collectsDestructiveKeys: true,
    },
    {
      name: 'notifications',
      dir: join(root, 'packages/notifications/src/locales'),
      localeRegistry: join(root, 'packages/notifications/src/i18n.ts'),
      sourceRoots: [join(root, 'packages/notifications/src'), join(root, 'services')],
      baseKeyOf: pushBaseKey,
      // Push copy renders on a Worker, whose runtime brings its own
      // `Intl.PluralRules` and ships no polyfill data.
      selectableCategoriesOf: tag =>
        new Set([...new Intl.PluralRules(tag).resolvedOptions().pluralCategories, 'zero']),
      englishCopyRules: [checkEnglishCopies, checkPushEnglishCopy],
      calledKeyOf: pushCalledKeyOf,
      keyPrefixOf: pushKeyPrefix,
      collectsDestructiveKeys: false,
    },
  ];
}

/**
 * English strings this product uses in two senses, so each sense needs a key.
 *
 * Every other piece of copy belongs to exactly one key. Two keys holding the
 * same English string drift apart the moment someone translates one of them,
 * and nothing downstream can tell which of the two the reader was meant to see.
 *
 * The value records why the split is real. Adding an entry claims the call sites
 * mean different things; removing one promises the copy means the same thing
 * everywhere it appears.
 *
 * Each key is the copy compared through `wording()`, so it is trimmed, case
 * folded and stripped of trailing sentence punctuation.
 */
const TWO_SENSE_COPY = new Map([
  [
    'open',
    'the verb on a button and an alert action, versus the state of a pull request, a finding and an invoice, versus the state of a review-memory proposal awaiting a decision',
  ],
  ['comment', 'the verb on a button, versus the noun on a row label and a badge'],
  [
    'outdated',
    "the discussion thread's staleness badge, versus the same label the thread's anchor line renders beside the file and line range",
  ],
  [
    'contact support',
    'the recovery action beside a Code Reviewer alert, versus the support contact beside the AI Guardrails availability notice',
  ],
  [
    'terms of service',
    "the document's own title on the Legal screen and the PR-discussion alert, versus the form the sign-in consent sentence's verb governs in an inflected language",
  ],
  [
    'receipt',
    'the confirmation a moderation report produces, versus the proof of payment for a credit purchase',
  ],
  ['expired', 'the state of a native-remote command delivery, versus the state of a credit grant'],
  ['block', 'the verb, block a discussion participant, versus the reviewer decision to block'],
  ['merge', 'the verb in the merge section header, versus the name of the merge method on a badge'],
  ['review', 'the noun, a review, versus the verb in the onboarding step'],
  ['high', 'the severity of a finding, versus the thinking effort of a model'],
  ['medium', 'the severity of a finding, versus the thinking effort of a model'],
  ['low', 'the severity of a finding, versus the thinking effort of a model'],
  [
    'manual review',
    'the suggested action for a security finding, versus the manual-review pull request feature',
  ],
  [
    'cancelled',
    'a state badge on a cancelled run or cancellation request, versus the audit timeline event that remediation was cancelled',
  ],
  [
    'deleted',
    'the state of a draft or item after deletion, versus the audit timeline event that a finding was deleted',
  ],
  [
    'dismissed',
    'the state of a finding or notification, versus the audit timeline event that a finding was dismissed',
  ],
  [
    'remediation requested',
    'the remediation timeline row on a finding, versus the audit report timeline event',
  ],
  [
    'remediation failed',
    'the remediation timeline row on a finding, versus the audit report timeline event',
  ],
  [
    'remediation blocked',
    'the remediation timeline row on a finding, versus the audit report timeline event',
  ],
  [
    'superseded',
    'the deadline badge naming a replaced finding, versus the audit timeline event that a finding was superseded',
  ],
  [
    'analysis failed',
    'the analysis state headline on a finding, versus the audit timeline event that an analysis failed',
  ],
  [
    'pr opened',
    'the remediation status row on a finding, versus the audit timeline event that a remediation PR was opened',
  ],
  [
    'no changes needed',
    'the remediation status row on a finding, versus the audit timeline event that remediation found no changes',
  ],
  ['none', 'no review gate, versus the thinking effort of a model'],
  ['files', 'the files in a pull request, versus the iOS Files app in the attachment picker'],
  ['plan', 'a billing plan, versus the agent plan mode'],
  ['copied', 'a file copied in a diff, versus the toast after a copy to the clipboard'],
  [
    '{{values}}',
    'two format-only sentences a key builds from its parts: the list of advanced-policy changes an audit row scanned, versus the joined pair of counted clauses a review-agent secret rotation reports',
  ],
]);

/**
 * Counted forms that say their number as a word instead of the visible count
 * placeholder, as `base key:plural category:locale`. Arabic names one day and
 * two days with their own word forms, and the singular and dual of any counted
 * noun inflect for the number, so those messages read as words and carry no
 * numeral. Every other form of a counted family must keep its language's exact
 * placeholder set, so a count deleted from a form that should show it still
 * fails. Add an entry only after reading the rendered message.
 */
const WORDED_COUNTS = new Set([
  'securityAgent.dashboard.daysOverdue:one:ar',
  'securityAgent.dashboard.daysOverdue:two:ar',
  'securityAgent.deadline.overdue:one:ar',
  'securityAgent.deadline.overdue:two:ar',
  'securityAgent.deadline.dueInDays:one:ar',
  'securityAgent.deadline.dueInDays:two:ar',
  'securityAgent.automation.queued:one:ar',
  'securityAgent.automation.queued:two:ar',
  'securityAgent.settingsOverview.repositoriesCount:one:ar',
  'securityAgent.settingsOverview.repositoriesCount:two:ar',
  'agentChat.composer.charactersRemaining:one:mi',
  'agentChat.partRenderer.updatedFileCount:one:ar',
  'agentChat.partRenderer.updatedFileCount:two:ar',
  'agentChat.olderMessages.omitted:two:ar',
  'agentChat.contextUsage.stepsCount:one:ar',
  'agentChat.contextUsage.stepsCount:two:ar',
  'agentChat.contextUsage.modelsCount:two:ar',
  'nativeRemote.recoveryGaps:two:ar',
  'prReview.discussion.comment:two:ar',
  'prReview.tabs.discussionAccessibility:two:ar',
  'prReview.hunkRows.fileLoadedCount:two:ar',
  'prReview.hunkRows.fileLoadedOfTotalCount:two:ar',
  'organization.kiloPass.paidSeat:one:ar',
  'organization.kiloPass.paidSeat:two:ar',
]);

/**
 * Proper nouns, format-only strings, and pre-existing English-identical copy
 * outside this section's new keys. Remove a key from the set when that copy
 * is translated or the key is deleted.
 */
const ENGLISH_IDENTICAL_ALLOWLIST = new Set([
  'profile.providerAnaconda',
  'profile.providerApple',
  'profile.providerDiscord',
  'common.github',
  'common.gitlab',
  // Store names, used inside sentences the receipt and management rows build.
  'common.appStore',
  'common.googlePlay',
  'profile.providerGoogle',
  'profile.providerLinkedin',
  'profile.providerChatgpt',
  'profile.providerClaude',
  'consent.kilo',
  'securityAgent.findingDetails.cve',
  'securityAgent.findingDetails.ghsa',
  'securityAgent.findingDetails.sourceDependabot',
  // The audit report's change lines hold no prose of their own: a `$t()` label
  // reference, one separator, and two placeholders the catalog's own status or
  // severity words fill. A catalog that keeps the English connector reads in
  // its own language once the reference and the values resolve, so an
  // identical value is the finished translation, not a missing one.
  'securityAgent.auditReport.eventSeverityChange',
  'securityAgent.auditReport.eventStatusChange',
  'agentChat.toolCard.toolBash',
  'agentChat.toolCard.toolGlob',
  'agentChat.toolCard.toolGrep',
  'agentChat.modelCost.perMillion',
  'cloudAgent.preview.portLabel',
  'agentChat.tasks.progress',
  'agentChat.questionCard.option',
  'agentChat.sessionFilter.platformCli',
  'agentChat.sessionFilter.platformSlack',
  'agentChat.sessionFilter.platformLinear',
  'agentChat.repoPicker.platformBitbucket',
  'agentChat.prBadge.label',
  // Profile-editor examples that name the value's own syntax, not prose: a
  // slug the field validator accepts, a server name, and command lines whose
  // tool and package paths must stay literal. Every catalog keeps them English
  // so the example never contradicts validation.
  'profiles.mcp.namePlaceholder',
  'profiles.mcp.commandPlaceholder',
  'profiles.agents.slugPlaceholder',
  'profiles.slashCommands.namePlaceholder',
  'profiles.slashCommands.agentPlaceholder',
  // The skills.sh source label. It names the published site the skill is
  // installed from, so every catalog keeps the site's own spelling.
  'profiles.skillSourceSkillsSh',
  // The MCP count label. `MCP` is the protocol's own acronym, so every catalog
  // keeps the same "{{count}} MCP" the MCP-server rows use.
  'profiles.counts.mcp',
  // The inference protocols keep their published API names across locales.
  'modelChat.backends.chatCompletions',
  'modelChat.backends.responses',
  'modelChat.backends.messages',
  'share.reviewPrSubtitle',
  // Format-only strings with no translatable words: a placeholder-only screen
  // title, a placeholder-plus-UTC time-range label, and a pure $t() reference
  // that names the transcription-model section title.
  'prReview.screen.title',
  'securityAgent.auditReport.periodUtc',
  'preferences.transcriptionModel',
  // Pure $t() references in the tour: they name another key's label, so every
  // locale resolves them to its own translation through i18next nesting.
  'tour.cloudOptionTitle',
  // A placeholder-only accessibility label: the list's name and its open
  // counter joined by a comma, so a catalog may keep English punctuation.
  'todos.lists.rowA11y',
  // Format-only values with no translatable words: the briefing's lower-bound
  // marker, and the `{{start}} – {{end}}` join the brief window and the
  // organization request-logs window both read. The join is a separator
  // between two placeholders already formatted in the reader's locale, so
  // every catalog keeps English punctuation here.
  'agentBriefing.atLeast',
  'common.timeRange',
  // The organization plan's own tier names. They are product names, so every
  // catalog keeps them as the billing pages and the invoices spell them.
  'organization.hub.planTeams',
  'organization.hub.planEnterprise',
  // The CLI's product name, a title for a device-sessions row. A product name
  // has nothing to translate, so every catalog keeps the published spelling.
  'deviceSessions.kiloCli',
  // The request-logs row's marker for a request that spent the reader's own
  // provider key. `BYOK` is the acronym the provider-key screens and the
  // gateway's own copy use, so every catalog keeps it rather than transliterating
  // an initialism.
  'organization.requestLogs.byok',
  // The gateway's product name, the label of the switch that routes through it.
  // A product name has nothing to translate, so every catalog keeps the spelling
  // the gateway and its documentation publish.
  'organizationModelAccess.openrouter',
  // The review thread's line markers: format-only `L<n>` / `L<start>–L<end>`
  // patterns whose `L` marker and en dash are the universal diff-anchor
  // spelling, so every catalog keeps the English pattern. The words around
  // them live in the sentence keys (`lineOnPathLineSide`, …).
  'prReview.discussion.anchor.line',
  'prReview.discussion.anchor.lineRange',
  // The consent screen's analytics sentence ends in the processor's own
  // product name and domain, so every catalog spells it the same way.
  'consent.gatewayWho',
  // Duration unit symbols and the per-hour rate format: a short unit a
  // catalog writes in its own language (`sa`, `saac`, `ชม.`) is that
  // catalog's decision and reads on the screen this key renders, so the
  // audit does not judge whether the symbol matches English; `{{rate}}/h` is
  // a value already formatted in the reader's locale.
  'common.durationHourShort',
  'common.durationMinuteShort',
  'cloudAgent.compute.perHour',
  // The organization audit log's detail lines. Most of them are a formatted
  // event whose words belong to another key: a `$t()` reference to the field,
  // role, region or brand label the app already translates, or a lone
  // `{{placeholder}}` the row fills with a value the reader supplied. A
  // catalog that keeps the reference resolves it to its own language, so an
  // identical value there is the finished translation, not a missing one. The
  // keys that do carry words are absent from this list and must be translated.
  'organization.auditLog.detail.autoRoutingAdded',
  'organization.auditLog.detail.brand.github',
  'organization.auditLog.detail.brand.gitlab',
  'organization.auditLog.detail.brand.bitbucket',
  'organization.auditLog.detail.brand.discord',
  'organization.auditLog.detail.brand.slack',
  'organization.auditLog.detail.brand.linear',
  'organization.auditLog.detail.disabled',
  'organization.auditLog.detail.enabled',
  'organization.auditLog.detail.field.name',
  'organization.auditLog.detail.field.slug',
  'organization.auditLog.detail.field.roleDefinition',
  'organization.auditLog.detail.field.whenToUse',
  'organization.auditLog.detail.field.description',
  'organization.auditLog.detail.field.customInstructions',
  'organization.auditLog.detail.field.groups',
  'organization.auditLog.detail.fieldChange',
  'organization.auditLog.detail.fundsGranted',
  'organization.auditLog.detail.guardrailIdentity',
  'organization.auditLog.detail.guardrailStatus',
  'organization.auditLog.detail.guardrailEnforcement',
  'organization.auditLog.detail.guardrailSkill',
  'organization.auditLog.detail.guardrailTarget.mcp',
  'organization.auditLog.detail.guardrailTarget.skill',
  'organization.auditLog.detail.memberRole',
  'organization.auditLog.detail.region.us',
  'organization.auditLog.detail.region.eu',
  'organization.auditLog.detail.region.au',
  'organization.auditLog.detail.region.jp',
  'organization.auditLog.detail.reviewAgentPlatform',
  // The rotation sentence is format only: the renderer joins two counted
  // clauses, each translated in this catalog, so `{{values}}` reads the same in
  // every language on purpose.
  'organization.auditLog.detail.reviewAgentSecretRotated',
  'organization.auditLog.detail.role.owner',
  'organization.auditLog.detail.role.admin',
  'organization.auditLog.detail.role.billing_manager',
  'organization.auditLog.detail.role.member',
  'organization.auditLog.detail.settingAdvancedPolicies',
  'organization.auditLog.detail.settingBrowserControl',
  'organization.auditLog.detail.settingDataCollection',
  'organization.auditLog.detail.settingDefaultBehavior.auto',
  'organization.auditLog.detail.settingDefaultBehavior.specific',
  'organization.auditLog.detail.settingDefaultModelSet',
  'organization.auditLog.detail.settingDefaultModelRemoved',
  // The threshold on its own, for a balance-alert row whose recipient list was
  // emptied. It is the money value the row already formats, so `{{threshold}}`
  // reads the same in every language.
  'organization.auditLog.detail.settingMinimumBalanceThreshold',
]);

/**
 * Keys a locale must translate, per catalog, even where a catalog would
 * otherwise be allowed to keep the English copy.
 *
 * The Home screen's empty state says that nothing of the reader's own work is
 * running. A catalog that leaves that sentence in English renders an
 * untranslated screen for a reader who chose another language, so no locale may
 * copy English here — unlike the format-only and proper-noun keys above, which
 * are identical in every language on purpose.
 *
 * The map lists, per catalog, the keys no locale may leave in English. Removing
 * a key from a catalog's set promises its copy may now be identical to English
 * in that catalog.
 */
const MUST_TRANSLATE_KEYS = new Map([['mobile', new Set(['home.noLiveSessions'])]]);

/**
 * Push copy that is English on purpose, per catalog. A value listed for a tag
 * is not reported as untranslated for that tag.
 *
 * These four languages write the security-finding body
 * `{{findingTitle}} in {{repoFullName}}` with the same preposition word English
 * uses — "in" is the native word in each — so the copy is already right and
 * there is nothing to translate. Irish is not one of them: its preposition is
 * "i", so that catalog carries the translated body instead.
 */
const NOTIFICATIONS_ENGLISH_COPY_EXCEPTIONS = {
  af: ['{{findingTitle}} in {{repoFullName}}'],
  de: ['{{findingTitle}} in {{repoFullName}}'],
  it: ['{{findingTitle}} in {{repoFullName}}'],
  nl: ['{{findingTitle}} in {{repoFullName}}'],
};

/**
 * Mobile English copy one catalog keeps on purpose, each entry with the reason
 * it is the finished copy there: a borrowed technical term the locale really
 * writes in English, for instance.
 *
 * Shape: tag → { English value: reason }. `checkMobileLocaleEnglishCopy` skips
 * a value this map holds for that tag, so the entry is the only place that
 * promises the English word is correct for the catalog; the reason is what a
 * reviewer reads instead of re-deriving the decision. The value must match
 * `en.json` exactly, because the rule compares whole strings.
 */
const MOBILE_ENGLISH_COPY_EXCEPTIONS = {
  af: {
    '{{count}} agent':
      'Afrikaans counts the borrowed "agent" noun (profiles.agents section reads "Agent naam", "Voeg agent by"), so the singular count label matches',
    '{{itemCount}} item; {{last}}':
      'Afrikaans singular of the borrowed "item" noun is "item" (toolCard.filesBadge_one reads "{{displayCount}} item"), so the label matches',
    '{{itemCount}} items; {{last}}':
      'Afrikaans plural of the borrowed "item" noun is "items", so the condensed label keeps English word shape (toolRun.sheetTitle is native "Nutsmiddel-oproepe")',
    'Medium sandbox':
      'Afrikaans delegates sandbox tiers to English: the catalog\'s own large tier reads "Groot sandbox" (cloudAgent.compute.largeSandbox), so the medium tier matches with the borrowed "Medium sandbox"',
  },
  az: {
    '{{count}} agent':
      'Azerbaijani "agent" is the same word (borrowed agent = agent, profiles.agents uses it natively), so the one-category count label matches',
    'Agent slug':
      'Azerbaijani keeps the technical slug noun (slugPlaceholder "my-agent-1" is untouched), so the label stays "Agent slug" with the agent word natively spelled',
    'Bearer token':
      'Azerbaijani keeps the auth scheme name "Bearer token" (the HTTP authentication scheme is a proper product term), matching the sibling mcpOAuth tokens',
    token: 'Azerbaijani borrows "token" (plural "tokenlər"), so the one-category value matches',
  },
  bs: {
    '{{count}} agent': 'Bosnian spells agent the same way in the singular (Agenti, agenta)',
    'Bearer token':
      'Bearer is the HTTP authorization scheme name and Bosnian borrows token unchanged',
    'merge request':
      "GitLab's Bosnian locale leaves Merge request untranslated, and this catalog uses it as a declined loan noun everywhere (merge requesta, merge requestu)",
    'Merge request':
      "GitLab's Bosnian locale leaves Merge request untranslated, and this catalog uses it as a declined loan noun everywhere (merge requesta, merge requestu)",
    'Merge request !{{number}}':
      "GitLab's Bosnian locale leaves Merge request untranslated, and this catalog uses it as a declined loan noun everywhere (merge requesta, merge requestu)",
    token: 'Bosnian keeps the singular token unchanged; its plural is tokena',
  },
  ca: {
    '{{count}} agent': 'Catalan spells agent the same way in the singular',
    '{{count}} agents': 'Catalan spells the plural agents the same way',
    '{{count}} secret': 'Catalan spells secret the same way in the singular',
    '{{count}} secrets': 'Catalan spells the plural secrets the same way',
    '{{displayCount}} error':
      'Catalan spells the noun "error" identically in the singular (DIEC: l\'error), so the counted one form matches',
    '{{displayCount}} errors':
      'Catalan plurals "error" as "errors", which is spelled identically to English, so the counted base and other forms match',
  },
  cs: {
    '{{count}} agent':
      'Czech singular "1 agent" is spelled identically (profiles.agents section declined "agent" natively), so the one-category value matches',
    'merge request':
      'GitLab\'s own Czech locale file (locale/cs_CZ/gitlab.po, msgid "Merge request") leaves "Merge request" untranslated while translating merge as sloučit/sloučení ("Tento merge request byl sloučen."); our capitalized-copy convention keeps "Merge request" in all three mergeRequest keys',
    'Merge request':
      'GitLab\'s own Czech locale file (locale/cs_CZ/gitlab.po, msgid "Merge request") leaves "Merge request" untranslated; our capitalized-copy convention keeps "Merge request" in all three mergeRequest keys',
    'Merge request !{{number}}':
      'GitLab\'s own Czech locale file (locale/cs_CZ/gitlab.po, msgid "Merge request") leaves "Merge request" untranslated; the !{{number}} suffix is GitLab\'s own URL convention (merge_requests/!123)',
    token:
      'Czech singular "1 token" matches (plural "tokenů" already translated in tokens_other), so the one-category value matches',
  },
  da: {
    '{{count}} agent': 'Danish spells agent the same way in the singular; its plural is agenter',
    'Download model':
      "download is the Danish verb downloade in the imperative; the catalog's other labels read Download model til enheden",
    'Send review':
      'Send is the Danish imperative of sende and review is the borrowed noun this block already uses (Review sendt til agenten)',
  },
  de: {
    'Name (optional)':
      'German spells both words identically: "Name" is the German word and "(optional)" is a natively German loan adjective, matching the catalog\'s own "API-Schlüssel (optional)" and "Zusammenfassung (optional)" unnamed labels elsewhere',
  },
  et: {
    '{{count}} agent': 'Estonian "agent" is the same word, so the one-category count label matches',
    dollar:
      'Estonian "dollar" is the same word (agents.sessionRow dollar/dollar area, gen. "dollarit" elsewhere), so the one-category value matches',
    token: 'Estonian borrows "token" (plural "tokenid"), so the one-category value matches',
  },
  eu: {
    token: 'Basque "token" is a loaned root (plural "tokenak"), so the one-category value matches',
  },
  es: {
    '{{displayCount}} error':
      'Spanish spells the noun "error" identically in the singular (RAE: el error), so the counted one form matches; the plural (errores) and the many form (de errores) are translated',
  },
  fi: {
    token: 'Finnish keeps the nominative singular token unchanged; its partitive is tokenia',
  },
  fil: {
    '{{count}} tool':
      'Filipino counts the English-loan noun bare: the catalog\'s own phrase "Mga available na tool: {{count}}" (modelChat.mcp.available) keeps the tool noun untranslated',
    '{{itemCount}} item; {{last}}':
      'Filipino keeps the borrowed "item" noun here (plural "mga item" elsewhere in the catalog) and the native `;` between them, so the family stays one form',
    'Access key ID':
      'Filipino keeps AWS field names in English, as the whole profile.providerKeys section does around accessKeyId',
    'API key':
      'Filipino keeps this technical term in English: the catalog\'s own keys read "ang key" (profile.providerKeys.add)',
    'Audit log':
      'Filipino borrows this term as Taglish: the audit actions around it are Taglish but this section title reads like the borrowed noun the catalog uses for log entries',
    'Auto top-up':
      'Filipino keeps this already-loanword term untranslated: "auto top-up" recurs in organization.billing.manageAutoTopUp ("Pamahalaan ang auto top-up") and setupAutoTopUp ("I-set up ang auto top-up")',
    'AWS region':
      'Filipino keeps the AWS product name in English (profile.providerKeys.accessKeyId keeps AWS field names)',
    'Bearer token':
      'Filipino keeps the technical terms in English: modelChat.mcpOAuth.fieldToken leaves "Token" untranslated next to authBearer',
    commit:
      'Filipino keeps the Git noun in English: the family\'s other form reads "na commit" (prReview.overview.commit_other) and mergedAgo="Na-merge {{time}}"',
    'Context window: {{value}}':
      'Filipino keeps the technical context-window term in English: agentChat.contextUsage.ofWindowTokens says "sa {{window}} na token"',
    'Deployment name':
      'Filipino keeps the English technical term: profile.providerKeys.incompleteMapping says "... at deployment name"',
    'Download code':
      'Filipino treats the verb as English loan (mag-download) and the label names the code: profile.dataExport.codePlaceholder="Code mula sa email" and getCodeA11y="I-email sa akin ang download code"',
    'Gateway model slug':
      'Filipino keeps this three-term technical slug in English: profile.providerKeys.incompleteMapping="Kailangan ng Mapping {{number}} ang parehong gateway model slug at deployment name."',
    'Google Cloud project':
      'Filipino keeps the Google Cloud product name in English: profile.providerKeys fields are translated around it (clientEmail="Email ng service account") while the product name stays',
    'Kilo app':
      '"Kilo app" names the product and is used untranslated in deviceSessions.signInScopeNote',
    'Kilo app · Android':
      '"Kilo app" is the untranslated product name; Android is the unchanged system name (deviceSessions.kiloCli="Kilo CLI" stays English)',
    'Kilo app · iOS':
      '"Kilo app" is the untranslated product name; iOS is the unchanged system name (deviceSessions.kiloCli="Kilo CLI" stays English)',
    'Kilo system':
      '"Kilo" is the product name, so the value names the system and cannot be translated (securityAgent.auditReport actors elsewhere say "Tagapangasiwa ng Kilo", keeping the name)',
    'merge request':
      'Filipino keeps GitLab\'s merge request in English: GitLab\'s Filipino translation catalog translates only ~29% of strings, and the catalog itself mixes both (codeReviewer.manualReview.mergeRequestUrl="URL ng merge request")',
    'Merge request':
      'Filipino keeps GitLab\'s merge request in English (GitLab Filipino translation coverage is ~29%): the catalog mixes both (prReview.merge.terminal.closedMergeRequest="Nakasara ang merge request na ito")',
    'Merge request !{{number}}':
      'Filipino keeps GitLab\'s merge request in English (GitLab Filipino translation coverage is ~29%): the catalog mirrors it in codeReviewer.manualReview.mergeRequestUrl="URL ng merge request"',
    'Prompt injection':
      'Filipino keeps the technical term in English: organizationGuardrails.detector.promptInjection.description says "Nade-detect ang mga pagtatangka"',
    'Secret access key':
      'Filipino keeps AWS field names in English (profile.providerKeys.accessKeyId)',
    token:
      'Filipino keeps the technical token noun in English: agentChat.contextUsage.ofWindowTokens="sa {{window}} na token" and plural form tokensWithPercentage keep it',
  },
  fr: {
    '{{count}} agent':
      'French "agent" is spelled the same (singular), so the count label is correct French',
    '{{count}} agents':
      'French spells "agents" identically (plural of agent); the count label is correct French (profiles.agents.limitReached uses "{{max}} agents" too)',
    '{{count}} secret':
      'French "secret" is spelled the same (singular); the MCP count label reads correctly',
    '{{count}} secrets':
      'French plural "secrets" is spelled the same, so the MCP count label matches',
  },
  hr: {
    '{{count}} agent':
      "Croatian spells the noun 'agent' identically; plural inflects ('{{count}} agenata')",
    'Bearer token':
      "Croatian keeps the OAuth scheme name 'Bearer token' as an English technical term; the family counts with the loanword (tokens_other 'tokena')",
    token:
      "Croatian uses the loanword token; the counted singular is identical, the plural is 'tokena'",
  },
  ht: {
    'merge request':
      'GitLab has no Haitian Creole locale, and this catalog names the GitLab object in English in every sibling string (Pataje merge request la)',
    'Merge request':
      'GitLab has no Haitian Creole locale, and this catalog names the GitLab object in English in every sibling string (Merge request la pa disponib)',
    'Merge request !{{number}}':
      'GitLab has no Haitian Creole locale, and this catalog names the GitLab object in English in every sibling string (Merge request la pa disponib)',
  },
  hu: {
    cent: "Hungarian spells the currency subunit 'cent' identically to English (MNB coin/cash naming); the sessionRow family already renders cent/cent_other as 'cent'",
    commit:
      "Hungarian developer copy keeps the Git noun 'commit' unchanged, as the same catalog does in the prReview.overview commit/commit_other rows and in agents.triggers.autoCommit context",
    token:
      "Hungarian borrowed technical term 'token': the established loanword here (sibling contextUsage tokens/tokens_other/tokensWithPercentage and reviewDetail.tokens all keep 'token')",
  },
  id: {
    'Edit server: {{name}}':
      'The accessibility twin of the same row label, so it keeps the borrowed "Edit server" wording the block uses everywhere',
    'Edit server':
      'Bahasa Indonesia borrows the verb-edit + server noun as-is: the whole mcp block reads "Tambah server MCP", "Hapus server", "URL server", and KBBI records "server" as the standard loan',
    commit:
      "Bahasa Indonesia keeps the Git noun at every count ('komit' is not this catalog's wording; overview commit/commit_other and toolRun labels read 'commit')",
    token:
      "Bahasa Indonesia writes the LLM/context unit as the loanword 'token' (KBBI has no replacement; the catalog renders the concept identically in 5 sibling keys: contextUsage tokens, tokens_other, tokensWithPercentage, reviewDetail.tokens, usage.entrySubtitle)",
  },
  ig: {
    'Gateway model slug':
      'Igbo borrows the slug/deployment field names: this catalog\'s own provider-key sentences keep "slug" and "deployment name" untranslated inside Igbo sentences',
  },
  it: {
    '{{displayCount}} file':
      "Italian 'file' is an invariable loanword (garzantina: il file / i file) and this catalog's own common.file, prReview.fileList and filesBadge_other rows keep it",
    commit:
      "Italian developer copy uses the English Git noun 'commit' (Treccani/Zingarelli loanword for the VCS entry), matching this catalog's own prReview.overview.commit rows",
    'merge request':
      "Italian keeps GitLab's English product name (GitLab docs in Italian use 'merge request'; sibling codeReviewer.manualReview.invalidMergeRequestUrl 'URL valido di una merge request' and mergeRequestUrl 'URL della merge request')",
    'Merge request': 'Same product-name loanword, capitalised as a UI heading like the English',
    'Merge request !{{number}}':
      'Same product-name loanword with the GitLab ref marker, as English',
    token:
      "Italian loanword for the session/LLM unit; the catalog renders this concept with 'token' in five sibling keys (contextUsage tokens*, tokensWithPercentage, reviewDetail.tokens)",
  },
  mg: {
    commit:
      'Malagasy borrows the Git noun "commit"; the counted singular matches the family\'s English-identical loan form',
    'Gateway model slug':
      'Malagasy borrows the technical slug term: the catalog\'s own provider-key sentences keep "slug" and "deployment name" in English inside Malagasy sentences',
  },
  ms: {
    token:
      "Bahasa Melayu writes the LLM/context unit as the loanword 'token' (DBP kamus lists no replacement; the catalog renders the concept identically in sibling keys contextUsage tokens, tokens_other, tokensWithPercentage, reviewDetail.tokens)",
  },
  nb: {
    '{{count}} agent': 'Norwegian spells agent the same way in the singular',
    token: 'Norwegian keeps the singular token unchanged; its plural is tokener',
  },
  nl: {
    '{{count}} agent':
      "Dutch spells the noun 'agent' identically; the plural inflects to '{{count}} agenten'",
    '{{count}} open':
      "Dutch spells the adjective 'open' identically; todos.lists counts open items",
    '{{displayCount}} open':
      "Dutch spells the adjective 'open' identically; sibling dashboard lines render '{{displayCount}} kritiek' and '{{displayCount}} hoog'",
    commit: "Dutch lowercases the Git noun 'commit' exactly as English does",
    'Online hosts':
      "Dutch keeps the loanword host (sibling nativeRemote.hostsEmpty says 'Geen online hosts') and online is the same word in Dutch",
  },
  pl: {
    '{{count}} agent':
      "Polish spells the noun 'agent' identically; plural inflects ('{{count}} agentow' and 'agenta')",
    token: "Polish uses the loanword token; counted singular identical, plural 'tokeny'/'tokenow'",
  },
  pt: {
    commit:
      "Portuguese developer copy uses the English Git noun 'commit'; the catalog's own prReview.overview.commit_other also equals the loanword for the same concept",
  },
  'pt-BR': {
    '{{itemCount}} item; {{last}}':
      'Counted item list; "item" is the catalog\'s own word for a tool-run entry ("itens" in the plural members)',
    commit:
      'The pt-BR catalog\'s commit-count family reads "alterações registradas" for plurals and keeps "commit" as the noun elsewhere (prReview.headLine "commit de origem {{sha}}")',
    'merge request':
      '"Merge request" is the catalog\'s established borrowed term for the GitLab noun across all 21 MR keys ("Compartilhar merge request", "Merge request indisponível")',
    'Merge request':
      '"Merge request" is the catalog\'s established borrowed term for the GitLab noun across all 21 MR keys',
    'Merge request !{{number}}':
      "Same borrowed term with the reference suffix; the catalog's mergeRequestUnavailable/accessDenied keys use it identically",
  },
  ro: {
    '{{count}} agent':
      'Romanian "agent" is the same Latin loanword spelled identically (catalog: "Agent", "Agenți"); {{count}} agent is correct copy',
    '{{count}} secret':
      'Romanian "secret" is the same Latin loanword spelled identically (catalog: "secret", "secrete"); {{count}} secret is correct copy',
    'Agent slug':
      'The ro catalog\'s slug family borrows the term ("Introduceți un slug de agent"); the label reads as the catalog does elsewhere',
    commit:
      'Romanian GitLab keeps the Git noun (ro_RO gitlab.po: "Commit" → "Commit"); the ro catalog itself renders "de commituri"',
    'Deployment name':
      'This ro catalog consistently borrows "deployment name" in the same section (modelMappingsDescription, incompleteMapping), so changing one key would split the wording',
    'Gateway model slug':
      'The ro catalog borrows the term verbatim in the same section (modelMappingsDescription, incompleteMapping); slug stays English as in ro_RO gitlab.po ("Project slug" → "Slug de proiect")',
    'merge request':
      'Romanian GitLab UI keeps the English term (locale/ro_RO gitlab.po, 249 translated MR strings all write "merge request"/"merge request-uri")',
    'Merge request':
      'Romanian GitLab UI keeps the English term, capitalised as in English (ro_RO gitlab.po: "Merge request" → "Merge request")',
    'Merge request !{{number}}':
      'Same GitLab English term with the reference suffix, as the catalog renders the standard-type headings',
    token:
      'Romanian GitLab keeps the noun (ro_RO gitlab.po: "Access Token" → "Token de acces"); the ro catalog itself renders "tokenuri"',
  },
  sk: {
    '{{count}} agent':
      'Slovak counts the model-word forms bare (profiles.counts.agents_other="{{count}} agentov", profiles.agents.limitReached="najviac {{max}} agentov"): singular "{{count}} agent" matches them',
    'merge request':
      'Slovak keeps GitLab\'s term untranslated: the whole sk catalog already uses "merge request" (prReview.connect.gitlabInstanceMismatchDescription="...ale tento merge request je na {{requested}}")',
    'Merge request':
      'Slovak keeps GitLab\'s untranslated "merge request" term throughout its catalog (prReview.terms.mergeRequestUnavailable="Merge request nie je dostupný")',
    'Merge request !{{number}}':
      'Slovak keeps GitLab\'s untranslated "merge request" term throughout its catalog (codeReviewer.manualReview.mergeRequestUrl="URL adresa merge requestu")',
    token:
      'Slovak keeps the technical token noun: plurals are "tokeny/tokenu/tokenov" (agentChat.contextUsage.tokens_*), so the singular "token" matches',
  },
  sl: {
    '{{count}} agent':
      'Slovenian "agent" is the same loanword (catalog: "Agent"); {{count}} agent is correct copy',
  },
  sq: {
    token:
      "Albanian borrows the noun unchanged: family is 'token' (one) vs 'tokene' (other); the counted singular is identical to English",
  },
  sr: {
    'Bearer token':
      'The HTTP scheme name "Bearer" plus the catalog\'s own "Token" noun (fieldToken "Token", tokens_other "tokeni"), so the auth row reads the scheme the way siblings spell it',
    '{{count}} agent':
      'Serbian "agent" is the same loanword (catalog: "Agent"); {{count}} agent is correct copy',
    token:
      'Serbian dev usage keeps "token"; the catalog itself renders "Token", "tokeni", "tokena"',
  },
  sv: {
    '{{count}} agent': 'Swedish spells agent the same way in the singular',
    cent: 'Swedish writes cent the same way',
    dollar: 'Swedish writes dollar the same way',
    'merge request':
      "GitLab's Swedish locale leaves Merge request untranslated, and this catalog inflects it as a Swedish loan noun (merge requesten)",
    'Merge request':
      "GitLab's Swedish locale leaves Merge request untranslated, and this catalog inflects it as a Swedish loan noun (den här merge requesten)",
    'Merge request !{{number}}':
      "GitLab's Swedish locale leaves Merge request untranslated, and this catalog inflects it as a Swedish loan noun (den här merge requesten)",
    token: 'Swedish leaves the singular token unchanged and uses the same form for the plural',
  },
  th: {
    'merge request':
      "GitLab's Thai locale has no translated string, and this catalog names the GitLab object in English in every sibling string (แชร์ merge request)",
    'Merge request':
      "GitLab's Thai locale has no translated string, and this catalog names the GitLab object in English in every sibling string (เปิด merge request ไม่ได้)",
    'Merge request !{{number}}':
      "GitLab's Thai locale has no translated string, and this catalog names the GitLab object in English in every sibling string (เปิด merge request ไม่ได้)",
  },
  uz: {
    '{{count}} agent':
      "Uzbek spells the noun 'agent' identically; the count word 'ta' carries the number",
    token:
      'Uzbek uses the loanword token identical to English; the counted singular is the same form',
  },
  vi: {
    commit: 'Vietnamese dev usage keeps "commit"; the vi catalog renders "commit" at every count',
    token: 'Vietnamese dev usage keeps "token"; the vi catalog renders "token" at every count',
  },
};

/**
 * Counted bucket phrases that two dashboard lines render. The repository row
 * and the deadline breakdown name the same bucket in their own wording (pt-BR
 * says "críticas" on the row and "críticos" in the breakdown), so those keys
 * carry the same English string on purpose and a catalog may translate the two
 * apart.
 *
 * This record is the only skip for those keys. The duplicate-copy rule in
 * `checkEnglishCopies` and the one-wording rule in `checkSharedWordings` both
 * read it, so one entry exempts a phrase from each rule at once.
 */
const PER_LINE_BUCKET_PHRASES = new Set([
  'securityAgent.dashboard.repoSummaryCritical',
  'securityAgent.dashboardMetrics.breakdownCritical',
  'securityAgent.dashboard.repoSummaryHigh',
  'securityAgent.dashboardMetrics.breakdownHigh',
]);

/**
 * The supported tags, read from the one source of truth.
 *
 * A `null` tag list means the list could not be read, which is not the same as
 * an empty list: the rule that compares catalog files against the list then has
 * nothing to compare, so it reports nothing instead of one line per file. Its
 * caller reads `null` as "skip that rule" and still runs every other rule. Each
 * early return below reports the one cause it stopped at.
 */
function supportedLanguages(root) {
  const file = join(root, 'apps/mobile/src/i18n/languages.ts');
  if (!existsSync(file)) {
    return {
      tags: null,
      problems: [`mobile: no supported-language list at ${relativePath(root, file)}`],
    };
  }
  const read = readAuditText(file, 'mobile', 'the supported-language list');
  if (read.text === null) {
    return { tags: null, problems: read.problems };
  }
  const entry = parseSourceEntry(root, root, file, read.text);
  if (entry.problems.length > 0) {
    // The tree a failed parse yields is not the one the walk below reads, so
    // "not declared" would repeat the cause the parse error already names.
    return { tags: null, problems: entry.problems };
  }
  const declarations = [];
  walk(entry.program, node => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.id.name === 'SUPPORTED_LANGUAGES'
    ) {
      declarations.push(node);
    }
  });
  if (declarations.length === 0) {
    return { tags: null, problems: [`${entry.path}: SUPPORTED_LANGUAGES is not declared`] };
  }
  const tags = [];
  for (const node of declarations) {
    const init = node.init === null ? null : unwrap(node.init);
    if (init?.type !== 'ArrayExpression') {
      return {
        tags: null,
        problems: [`${entry.path}: SUPPORTED_LANGUAGES is not an array literal`],
      };
    }
    for (const element of init.elements) {
      const value = element === null ? null : unwrap(element);
      // An element the walker cannot decode leaves the list incomplete, so
      // every tag it may hold would read as an unsupported language.
      if (value?.type !== 'Literal' || typeof value.value !== 'string') {
        return {
          tags: null,
          problems: [`${entry.path}: SUPPORTED_LANGUAGES has an element this check cannot read`],
        };
      }
      tags.push(value.value);
    }
  }
  return { tags, problems: [] };
}

/**
 * The keys each object of a catalog declares, read in one pass over its text.
 *
 * A string is content from its opening quote to its closing quote, escapes
 * included, so a message that carries braces or a `"key":`-shaped run is never
 * mistaken for nesting or for a key. Only a brace outside a string opens or
 * closes an object. A catalog that ends inside a string, or whose braces do not
 * balance, is unreadable: no key scope can be trusted, so the scan stops.
 */
function scanCatalogKeys(text) {
  const duplicates = [];
  const stack = [new Set()];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      if (end >= text.length) {
        return { duplicates, readable: false };
      }
      let after = end + 1;
      while (/\s/.test(text[after] ?? '')) {
        after += 1;
      }
      // A string followed by a colon is a key; a string on the value side is
      // content, whatever it reads.
      if (text[after] === ':') {
        const key = text.slice(index + 1, end);
        const scope = stack.at(-1);
        if (scope.has(key)) {
          duplicates.push(key);
        }
        scope.add(key);
      }
      index = end + 1;
      continue;
    }
    if (char === '{') {
      stack.push(new Set());
    } else if (char === '}') {
      if (stack.length === 1) {
        return { duplicates, readable: false };
      }
      stack.pop();
    }
    index += 1;
  }
  return { duplicates, readable: stack.length === 1 };
}

/**
 * Read one hand-written audit input, reporting a read the filesystem refuses.
 *
 * These inputs are edited by hand, so a path `existsSync` accepts can still
 * refuse a read: a directory, a missing file, or a permission the process
 * lacks. One named problem line lets the rest of the audit report, the way an
 * unreadable catalog does.
 *
 * Returns the text, or `null` with the problem to report.
 */
function readAuditText(file, label, what) {
  try {
    return { text: readFileSync(file, 'utf8'), problems: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: null, problems: [`${label}: cannot audit ${what}: ${message}`] };
  }
}

/**
 * Parse a catalog and report a key that appears twice in one object. JSON.parse
 * keeps the last duplicate silently, so the raw text is the only witness.
 *
 * A catalog this cannot read is reported once and skipped, the way
 * `check-plurals.mjs` treats a locale it cannot audit: a read the filesystem
 * refuses, an unbalanced scan, or a file JSON.parse rejects leaves one problem
 * line instead of a stack trace and a cascade of missing-key findings.
 */
function parseCatalog(file, label) {
  const problems = [];
  const read = readAuditText(file, label, 'catalog');
  problems.push(...read.problems);
  if (read.text === null) {
    return { catalog: null, problems };
  }
  const text = read.text;
  const { duplicates, readable } = scanCatalogKeys(text);
  if (!readable) {
    problems.push(`${label}: cannot audit catalog: its strings and braces do not balance`);
    return { catalog: null, problems };
  }
  let catalog;
  try {
    catalog = flattenCatalog(JSON.parse(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`${label}: cannot audit catalog: ${message}`);
    return { catalog: null, problems };
  }
  for (const key of duplicates) {
    problems.push(`${label}: duplicate key "${key}"`);
  }
  return { catalog, problems };
}

/**
 * The agent editor's three visibility options each read `label — description`.
 * A catalog that separates one option with an en dash, a hyphen, a colon, or no
 * space at all draws one radio group in three shapes, and the reader has to
 * compare the labels to see that they are the same kind of thing.
 */
const VISIBILITY_KEYS = [
  'profiles.agents.visibilityPrimary',
  'profiles.agents.visibilitySubagent',
  'profiles.agents.visibilityAll',
];

/**
 * Catalog values that must read the same in every language. `profiles.agents.topP`
 * is the sampling parameter's published name, so a translated word would hide
 * which parameter the field sets; `profiles.mcp.jsonPlaceholder` is the JSON
 * sample the multiline field shows the reader, and a translated one stops
 * demonstrating the shape. This list is the only registry of keys that must read
 * English: `checkVerbatimLabels` requires it, and the identical-copy rules
 * derive their exemption from it through `VERBATIM_KEY_SET`. The serialized-JSON
 * rule exempts only `JSON_SAMPLE_KEY`, because a verbatim label still must not
 * hold JSON text in English.
 */
const VERBATIM_KEYS = ['profiles.agents.topP', 'profiles.mcp.jsonPlaceholder'];

const VERBATIM_KEY_SET = new Set(VERBATIM_KEYS);

/**
 * Whether a key may read English here: one listed in `VERBATIM_KEYS` must,
 * while one in `ENGLISH_IDENTICAL_ALLOWLIST` may.
 */
function expectsEnglishCopy(key) {
  return VERBATIM_KEY_SET.has(key) || ENGLISH_IDENTICAL_ALLOWLIST.has(key);
}

function checkVerbatimLabels(values, english, label) {
  const problems = [];
  for (const key of VERBATIM_KEYS) {
    const value = values.get(key);
    const reference = english.get(key);
    if (value !== undefined && reference !== undefined && value !== reference) {
      problems.push(`${label}: "${key}" must read "${reference}" in every catalog`);
    }
  }
  return problems;
}

function checkVisibilitySeparators(values, label) {
  const problems = [];
  for (const key of VISIBILITY_KEYS) {
    const value = values.get(key);
    if (value !== undefined && value.split(' — ').length !== 2) {
      problems.push(`${label}: "${key}" must join its label and description with " — "`);
    }
  }
  return problems;
}

/**
 * The agent editor's catalog rules. The separator rule judges any catalog,
 * English included. The verbatim rule reads a translated catalog against the
 * English reference, so it does not run on the English pass, where the two maps
 * would be the same.
 */
function checkAgentEditorCopy(values, english, label) {
  return [
    ...checkVisibilitySeparators(values, label),
    ...checkVerbatimLabels(values, english, label),
  ];
}

/**
 * The pull-request term keeps its capital: the acronym is `PR` in any
 * position, and a hyphenating language writes it `Pull-Request`. A translation
 * batch lowercased the first letter of both, so 42 catalogs read "pR" or
 * "pull-Request" wherever the term reaches a sentence. `common.pullRequest`
 * supplies `{{requestNoun}}` in the manual-review start failures, so the
 * damage surfaces inside an otherwise translated sentence.
 */
const MISCASED_PULL_REQUEST_TERM =
  /(?<![A-Za-zÀ-ÿ])pR(?![A-Za-zÀ-ÿ])|(?<![A-Za-zÀ-ÿ])pull-Request(?![A-Za-zÀ-ÿ])/;

/**
 * The list conjunction `Intl.ListFormat` puts between two items in `tag`, read
 * from the formatter itself rather than a hand-written table: the sentence and
 * every catalog's own list join have to agree on one separator, and only the
 * platform knows it. Two sentinels that no label can contain isolate the
 * junction: the run between them is what the conjunction writes, spaces and
 * all (" and ", " und ", " و", "和").
 */
const listConjunctions = new Map();
function listConjunctionOf(tag) {
  if (!listConjunctions.has(tag)) {
    let conjunction = null;
    try {
      const joined = new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }).format([
        '\u0001\u0001',
        '\u0002\u0002',
      ]);
      conjunction = joined.split('\u0001\u0001')[1]?.split('\u0002\u0002')[0] ?? null;
    } catch {
      // A tag `Intl` refuses is reported once, by the catalog loop.
      conjunction = null;
    }
    listConjunctions.set(tag, conjunction === '' ? null : conjunction);
  }
  return listConjunctions.get(tag);
}

/**
 * The catalog keys the changelog sentence names as areas. `changelog-screen.ts`
 * maps eight areas; three are product names it writes itself, and the rest
 * render from these keys, so each of them becomes one item of the list.
 */
const CHANGELOG_AREA_KEYS = [
  'profile.changelogAreas.signIn',
  'profile.changelogAreas.profileOrganizations',
  'profile.changelogAreas.chat',
  'profile.changelogAreas.notifications',
  'profile.changelogAreas.integrations',
];

/**
 * The tag the app builds its formatters with. `lib/intl-cache.ts` names the
 * script or the region for two catalogs whose bare tag resolves to other data,
 * so a rule that reads the raw catalog name would judge the wrong conjunction
 * for them.
 */
const FORMATTER_TAGS = new Map([
  ['pt', 'pt-PT'],
  ['sr', 'sr-Latn'],
]);

/**
 * The changelog screen names the areas a release's fixes touched as one
 * `Intl.ListFormat` sentence, so each area label is one item of that list. A
 * label that carries the catalog's own list conjunction doubles it and the
 * reader cannot tell where one area ends: Hindi read "Cloud Agent, Security
 * Agent और प्रोफ़ाइल और संगठन" for three areas. The label joins its two nouns
 * with the language's own compound form instead (an ampersand, "व", "与"), and
 * the list supplies the only conjunction in the sentence.
 */
function checkChangelogAreaLabels(tag, values, label) {
  const problems = [];
  const conjunction = listConjunctionOf(FORMATTER_TAGS.get(tag) ?? tag);
  if (conjunction === null) {
    return problems;
  }
  for (const key of CHANGELOG_AREA_KEYS) {
    const value = values.get(key);
    if (value === undefined || !value.includes(conjunction)) {
      continue;
    }
    problems.push(
      `${label}: "${key}" contains the list conjunction "${conjunction.trim()}"; the changelog sentence joins the areas itself, so join this label's nouns another way`
    );
  }
  return problems;
}

/** Reject the miscased pull-request term, in English and in every locale. */
function checkPullRequestTerm(values, label) {
  const problems = [];
  for (const [key, value] of values) {
    const miscased = MISCASED_PULL_REQUEST_TERM.exec(value);
    if (miscased) {
      problems.push(
        `${label}: "${key}" writes the pull-request term "${miscased[0]}"; write "PR" or "Pull-Request"`
      );
    }
  }
  return problems;
}

/**
 * Armenian closes a sentence with `։` (U+0589) and holds one sentence's
 * clauses together with `՝` (U+055D). A translator who leaves the ASCII `.` or
 * `:` at a sentence boundary mixes two conventions on one screen. Only the
 * marks that close a sentence are read: an ellipsis, a host or file name, a
 * decimal, a `{{token}}` and a Latin abbreviation keep theirs.
 */
const ARMENIAN_SENTENCE_TERMINATORS = new Set(['hy']);
const ARMENIAN_UPPERCASE_AFTER_MARK = /^\s*[\u0531-\u0556]/;
const ARMENIAN_LOWERCASE_AFTER_SPACE = /^\s+[\u0561-\u0587]/;
const LATIN_AFTER_DOT = /[A-Za-z0-9]/;
/** Abbreviations that keep an ASCII `.` in place: «Էլ. փոստ», «օր. 50». */
const ARMENIAN_ABBREVIATION_BEFORE_DOT = /(?:^|[\s(«"'])(?:Էլ|էլ|օր|հր)$/;

/** Reject a sentence in the Armenian catalog that ends with an ASCII mark. */
function checkArmenianSentenceTerminator(tag, values, label) {
  const problems = [];
  if (!ARMENIAN_SENTENCE_TERMINATORS.has(tag)) {
    return problems;
  }
  for (const [key, value] of values) {
    for (let index = 0; index < value.length; index += 1) {
      const mark = value[index];
      if (mark !== '.' && mark !== ':') {
        continue;
      }
      // A run of dots is an ellipsis, a wait state rather than a sentence end.
      if (value[index - 1] === '.' || value[index + 1] === '.') {
        continue;
      }
      if (mark === '.' && LATIN_AFTER_DOT.test(value[index + 1] ?? '')) {
        continue;
      }
      const rest = value.slice(index + 1);
      if (
        mark === '.' &&
        ARMENIAN_LOWERCASE_AFTER_SPACE.test(rest) &&
        !ARMENIAN_ABBREVIATION_BEFORE_DOT.test(value.slice(0, index))
      ) {
        problems.push(
          `${label}: "${key}" joins two sentences with the ASCII "."; Armenian writes «։» and «՝»`
        );
        continue;
      }
      if (rest.trim() !== '' && !ARMENIAN_UPPERCASE_AFTER_MARK.test(rest)) {
        continue;
      }
      problems.push(
        `${label}: "${key}" ends a sentence with the ASCII "${mark}"; Armenian writes «։»`
      );
    }
  }
  return problems;
}

/**
 * The Devanagari danda `।` (U+0964) closes a sentence in the scripts that
 * write it. A catalog states its own sentence mark in `common.sentenceJoiner`,
 * so a catalog that joins its sentences with another mark must not borrow it:
 * a batch imported from a danda source leaves one screen with two sentence
 * terminators, and the mark belongs to another script. The notifications push
 * catalog carries no joiner at all and writes no sentence mark, so a danda
 * there is reported too.
 */
function checkBorrowedDanda(values, label) {
  const problems = [];
  const joiner = values.get('common.sentenceJoiner');
  if (typeof joiner === 'string' && joiner.startsWith('\u0964')) {
    return problems;
  }
  for (const [key, value] of values) {
    if (!value.includes('\u0964')) {
      continue;
    }
    problems.push(
      typeof joiner === 'string'
        ? `${label}: "${key}" writes the Devanagari danda «।» while this catalog joins its sentences with "${joiner}"`
        : `${label}: "${key}" writes the Devanagari danda «।», and this catalog writes no sentence mark of its own`
    );
  }
  return problems;
}

/** The mark an Urdu catalog declares as its sentence terminator. */
const URDU_SENTENCE_TERMINATOR = '\u06D4';
/** What continues a token after a dot rather than starting a sentence. */
const LATIN_OR_NUMBER_AFTER_DOT = /[A-Za-z0-9/%-]/;

/** Whether the character is a letter of the Arabic script, as Urdu words are. */
function isArabicLetter(char) {
  return char !== undefined && /\p{Script=Arabic}/u.test(char) && /\p{L}/u.test(char);
}

/**
 * The Urdu full stop `۔` (U+06D4) closes a sentence written in the Arabic
 * script, and a catalog that declares it in `common.sentenceJoiner` has stated
 * that this mark ends its sentences. An ASCII `.` left at a boundary then puts
 * two conventions on one screen. The rule reads that declared joiner instead of
 * a tag list for the same reason `checkBorrowedDanda` does: the joiner is the
 * catalog's own statement of which mark closes its sentences, so a catalog that
 * declares another mark keeps its ASCII periods and none is named here. Only a
 * mark that closes a sentence is read: an ellipsis, a host or file name and a
 * decimal keep theirs. A period followed by whitespace and a word closes one
 * sentence and opens the next whatever precedes it, so the sentence it joins is
 * reported after a `{{token}}` or a closing bracket too; a value-final period
 * is read only after an Urdu word, which leaves a Latin product name alone.
 */
function checkUrduSentenceTerminator(values, label) {
  const problems = [];
  const joiner = values.get('common.sentenceJoiner');
  if (typeof joiner !== 'string' || !joiner.startsWith(URDU_SENTENCE_TERMINATOR)) {
    return problems;
  }
  for (const [key, value] of values) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== '.') {
        continue;
      }
      // A run of dots is an ellipsis, a wait state rather than a sentence end.
      if (value[index - 1] === '.' || value[index + 1] === '.') {
        continue;
      }
      // A host, file name or decimal continues with its own characters.
      if (LATIN_OR_NUMBER_AFTER_DOT.test(value[index + 1] ?? '')) {
        continue;
      }
      // A word after the dot means a second sentence follows it, whatever the
      // dot follows: `{{status}}. ہدف` joins two sentences as surely as a dot
      // after an Urdu word does.
      if (/^\s+\p{L}/u.test(value.slice(index + 1))) {
        problems.push(`${label}: "${key}" joins two sentences with the ASCII "."; Urdu writes «۔»`);
        continue;
      }
      // A dot that ends the value, or runs straight into the next word with no
      // space, closes a sentence only after an Urdu word: `Sentry.` names a
      // product and `{{status}}.` a value, not a sentence.
      if (!isArabicLetter(value[index - 1])) {
        continue;
      }
      if (/\p{L}/u.test(value.slice(index + 1))) {
        problems.push(`${label}: "${key}" joins two sentences with the ASCII "."; Urdu writes «۔»`);
        continue;
      }
      problems.push(`${label}: "${key}" ends a sentence with the ASCII "."; Urdu writes «۔»`);
    }
  }
  return problems;
}

/** The `{{token}}` list of one string, in the order it writes them. */
function placeholderTokens(value) {
  return [...value.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map(match => match[1]);
}

/** The sorted, comma-joined signature the diagnostics print for one token list. */
function signature(tokens) {
  return tokens.slice().sort().join(',');
}

/** The `$t(key)` set of one string. A copy names a label; it never spells it. */
function nestingRefs(value) {
  return [...value.matchAll(/\$t\(\s*([^)\s,]+)\s*\)/g)].map(match => match[1]).sort();
}

/**
 * The `$TOKEN` expansion tokens of one string, e.g. `$ARGUMENTS`. Kilo expands
 * these literally, so a translator who spells one out (or translates it) leaves
 * the reader with a token nothing replaces. The set must match English.
 */
function expansionTokens(value) {
  return [...value.matchAll(/\$[A-Z][A-Z0-9_]*/g)].map(match => match[0]).sort();
}

/**
 * Whether one value still carries prose: a word of its own that starts with a
 * lowercase letter. Placeholders, `$t()` references and `$TOKEN` expansions are
 * removed first, so a value built only from them says nothing of its own, and an
 * acronym or a capitalised product name starts no lowercase letter and reads
 * the same in every language. The lookbehind keeps a lowercase letter inside a
 * word (`e.g.`, `iOS`) from counting as a word start.
 */
function carriesEnglishProse(value) {
  const stripped = value
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\$t\([^)]*\)/g, ' ')
    .replace(/\$[A-Z][A-Z0-9_]*/g, ' ');
  return /(?<![\p{L}\p{N}_-])\p{Ll}/u.test(stripped);
}

/** The leading and trailing whitespace of one string, as a signature. */
function edges(value) {
  return JSON.stringify([/^\s*/.exec(value)[0], /\s*$/.exec(value)[0]]);
}

/**
 * Keys whose surrounding whitespace is the sentence's own separator rather than
 * part of a word. The login screen joins `login.termsPrefix` straight to its
 * Terms link and puts `login.termsConnector` between the two links, so the
 * separator belongs to the locale: a catalog that separates words with a space
 * keeps that space in the value, and Chinese abuts the segments. Every other
 * key keeps English's edges exactly.
 */
const LOCALE_SEPARATED_KEYS = new Set([
  'login.termsPrefix',
  'login.termsConnector',
  // The context-usage pill appends the tap hint straight to the sentence the
  // pill's body sentence terminator closed, so the hint's leading separator is
  // the catalog's own: a space nearly everywhere, none where the sentence mark
  // alone separates ("ja", "zh-Hans", "zh-Hant"). "th" ends no sentence with a
  // mark, so it keeps the space the hint needs to stay a separate sentence.
  'agentChat.contextUsage.tapToViewDetails',
  // The sentence and list joiners are the catalog's own statement about how it
  // closes a sentence and separates two items, so both carry their own edges: a
  // space after the mark nearly everywhere, none where the mark alone separates
  // ("ja", "zh-Hans", "zh-Hant"), and none at all where the catalog writes no
  // mark ("th" separates its sentences with a bare space).
  'common.sentenceJoiner',
  'common.listJoiner',
]);

/**
 * The catalogs that close no sentence with a mark: Thai separates its
 * sentences with a bare space, so its `common.sentenceJoiner` is that space
 * and nothing else. Every other catalog's joiner carries its sentence
 * terminator, so a whitespace-only joiner there stays an untranslated string
 * the empty-value rule rejects.
 */
const MARKLESS_SENTENCE_TAGS = new Set(['th']);

/**
 * The counted clause the review-submit message renders before its stale
 * clause. Its trailing whitespace is the sentence separator, so every form of
 * the family states how the catalog joins one sentence to the next: a space
 * after the terminator in almost every language, nothing in Japanese and
 * Chinese. The helper concatenates the two clauses and adds no separator.
 */
const SENTENCE_SEPARATED_FAMILY = 'prReview.submit.partialPostedFresh';

/** The catalogs whose sentence terminator is the whole separator. */
const UNSPACED_SENTENCE_TAGS = new Set(['ja', 'zh-Hans', 'zh-Hant']);

/**
 * The catalogs that write their conjunction as a prefix letter of the next
 * word rather than as a word of its own. Arabic joins the waw to the noun it
 * governs, so `login.termsConnector` carries the space before the conjunction
 * and none after it. Every catalog that separates words with spaces and is
 * absent from this set separates the conjunction on both sides; a catalog that
 * abuts its words pads neither. A catalog whose orthography changes has to move
 * into or out of this set together with its values.
 */
const PREFIX_CONJUNCTION_TAGS = new Set(['ar']);

/** Whether the key's own edge whitespace is a separator this catalog chooses. */
function carriesOwnEdges(key) {
  return LOCALE_SEPARATED_KEYS.has(key) || pluralBaseKey(key) === SENTENCE_SEPARATED_FAMILY;
}

const QUOTE_PAIRS = [
  ['\u201c', '\u201d'],
  ['\u201e', '\u201c'],
  ['\u201e', '\u201d'],
  ['\u201e', '"'],
  ['\u00ab', '\u00bb'],
  ['\u00bb', '\u00ab'],
  ['\u2018', '\u2019'],
  ['\u201a', '\u2018'],
  ['\u201a', '\u2019'],
  ['[', ']'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
  ['\uff62', '\uff63'],
  ['\u2039', '\u203a'],
  ['\u300a', '\u300b'],
  ['"', '"'],
];
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One matcher per quote pair, compiled once for the process. The pattern
 * depends only on the pair, and `String.prototype.matchAll` clones the expression
 * it is handed, so a shared instance keeps no position between values; building
 * them per call repeated the same sixteen compiles for every catalog value.
 */
const QUOTE_PATTERNS = QUOTE_PAIRS.map(
  ([open, close]) =>
    new RegExp(
      `${escapeRegExp(open)}([^${escapeRegExp(close)}\n]{2,60})${escapeRegExp(close)}`,
      'gu'
    )
);

/**
 * Every quoted run short enough to name a control. A translator who spells a
 * button label instead of naming its key leaves the run here, where the
 * English-label check below can see it.
 */
function quotedRuns(value) {
  const runs = new Set();
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      runs.add(match[1].trim());
    }
  }
  for (const match of value.matchAll(/(?:^|[\s(:>\p{L}])'([^'\n]{2,60})'/gu)) {
    runs.add(match[1].trim());
  }
  return [...runs].filter(
    run => /\p{L}/u.test(run) && !/\{\{/.test(run) && run.split(/\s+/).length <= 6
  );
}

/**
 * Whether this catalog keeps `run` as a label of its own. A product name the
 * catalog does not translate sits in a value barely longer than the name, so
 * quoting it is right. A label the catalog does translate has no such value,
 * and quoting the English one names a control the user never sees.
 */
function holdsLabel(values, run) {
  for (const value of values) {
    if (value.length <= run.length + 6 && value.includes(run)) {
      return true;
    }
  }
  return false;
}

/**
 * The quoted runs of `value` that spell an English label: each names a control
 * this reader must see as `$t(key)`, not as the English word.
 *
 * The one exemption is an explicit parameter, not a second scan: `ownValues`
 * holds the locale's own values, and a run one of them holds is that locale's
 * copy of a name it does not translate, so quoting it is right. English passes
 * an empty set, because a label English spells is a label English can name.
 */
function quotedLabelRuns({ value, englishValues, ownValues }) {
  const runs = [];
  for (const run of quotedRuns(value)) {
    if (englishValues.has(run) && !holdsLabel(ownValues, run)) {
      runs.push(run);
    }
  }
  return runs;
}

/**
 * The catalog key a node names as a plain string: unwrapped from its
 * TypeScript-only wrappers, a `Literal` string, and non-empty. Any other node,
 * including a template literal and an empty string, names no key here. The read
 * itself is the shared one, so a key rule cannot see a literal shape the others
 * do not; the non-empty requirement is this layer's own.
 */
function staticStringKey(node) {
  const value = stringLiteralValue(node);
  return value !== null && value !== '' ? value : null;
}

/** The catalog key a property's value translates, when it is `t('literal')`. */
function propertyTranslation(property) {
  const value = unwrap(property.value);
  if (value.type !== 'CallExpression' || !isTranslateCallee(value.callee)) {
    return null;
  }
  const [first] = value.arguments;
  if (first === undefined) {
    return null;
  }
  return staticStringKey(first);
}

/**
 * The catalog keys one object literal paints on a destructive button.
 *
 * Two shapes write it: the `confirmLabel` a `useConfirmDialog().confirm()` call
 * passes, and an `Alert` button whose `style` is `'destructive'`. A
 * `confirmLabel` counts only when the object carries no `cancelLabel`, because
 * `destructive-confirm-dialog.tsx` renders the safe button as
 * `cancelLabel ?? t('common.cancel')`: a call site that names its own cancel
 * label never paints the generic one. An alert button always paints its own
 * text, so it counts either way.
 *
 * A `destructiveLabel` counts as the red choice of a confirmation that leaves
 * the safe button to the fallback. The name exists for exactly that role —
 * `consent-card.tsx` passes `actions.destructiveLabel` straight into
 * `confirm()` with no `cancelLabel` — and the cancel label, when one exists,
 * lives in the caller rather than in this literal, so the property's own object
 * says nothing about it.
 */
function destructiveLabels(object) {
  const properties = object.properties.filter(property => property.type === 'Property');
  const find = name => properties.find(property => propertyName(property) === name);
  const keys = [];
  const confirmLabel = find('confirmLabel');
  if (confirmLabel && !find('cancelLabel')) {
    const key = propertyTranslation(confirmLabel);
    if (key !== null) {
      keys.push(key);
    }
  }
  const destructiveLabel = find('destructiveLabel');
  if (destructiveLabel) {
    const key = propertyTranslation(destructiveLabel);
    if (key !== null) {
      keys.push(key);
    }
  }
  const style = find('style');
  const text = find('text');
  if (style && text) {
    const styleValue = unwrap(style.value);
    if (styleValue.type === 'Literal' && styleValue.value === 'destructive') {
      const key = propertyTranslation(text);
      if (key !== null) {
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * Three sets, read from every source root of one catalog:
 * - `called`: keys the catalog's own translate call names as a plain string.
 *   Each must exist.
 * - `referenced`: every string literal in the source, plus every literal
 *   written under the static head of a key the source builds as a template
 *   literal — `` `generic.body.${leaf}` `` reads `generic.body.`, so a leaf
 *   literal beside it names the key `generic.body.<leaf>`. A key named in a
 *   lookup table and passed to t() through a variable is used, so the dead-key
 *   check reads this wider set and never asks anyone to delete a live key.
 * - `destructiveKeys`: keys an object literal paints on a destructive button
 *   while the dialog can also paint the generic Cancel label. See the rule that
 *   reads this set, `destructiveConfirmKeys` below. Only the mobile catalog
 *   collects it: a destructive button is mobile copy, and the push catalog must
 *   not raise a finding on a key it does not paint.
 *
 * All three come from the syntax tree (tools/lib/ast.mjs), so text that only
 * looks like a call — in a comment, in a string, in a type annotation — moves no
 * key, and an apostrophe in prose cannot throw the quote pairing out of step.
 *
 * The scan also returns `complete`: false when a file could not be read or
 * parsed, or when a source root the audit had to have was missing. A key that
 * sits in such a file is invisible to all three sets, so the dead-key rule
 * reads this flag and names nothing from an incomplete scan — the same reason
 * `findOrphanedNoAgreementEntries` in tools/i18n/check-plurals.mjs returns
 * nothing from a scan with problems. `requiresSourceRoots` says the audit is
 * reading the repository root itself, where every declared root must be there:
 * a fixture tree holds only the parts a test gives it, so a root it does not
 * have has nothing to scan and is skipped without a word. When it is true, the
 * missing root is reported instead, because there every key under it would
 * otherwise read as dead.
 */
function scanSource(catalog, root, requiresSourceRoots) {
  const problems = [];
  const called = new Set();
  const referenced = new Set();
  const keyPrefixes = new Set();
  const destructiveKeys = new Set();
  let complete = true;
  const { calledKeyOf, keyPrefixOf, collectsDestructiveKeys } = catalog;
  for (const sourceRoot of catalog.sourceRoots) {
    if (!existsSync(sourceRoot)) {
      if (requiresSourceRoots) {
        problems.push(`${catalog.name}: no source tree at ${relativePath(root, sourceRoot)}`);
        complete = false;
      }
      continue;
    }
    for (const { file, program, problems: unparsed } of parseSourceTree(
      sourceRoot,
      root,
      isTestArtifact
    )) {
      // A file the parser refused has an empty tree, so its keys would leave
      // both sets without a word. `check:i18n` runs oxlint first, so this
      // normally reports nothing. A read the filesystem refused arrives the
      // same way, and either one leaves the scan incomplete: the keys of that
      // file are simply not in the sets.
      for (const problem of unparsed) {
        problems.push(problem);
      }
      if (unparsed.length > 0) {
        complete = false;
      }
      walk(program, node => {
        if (node.type === 'Literal' && typeof node.value === 'string') {
          if (node.value !== '') {
            referenced.add(node.value);
          }
          return;
        }
        if (node.type === 'ObjectExpression') {
          if (collectsDestructiveKeys) {
            for (const key of destructiveLabels(node)) {
              destructiveKeys.add(key);
            }
          }
          return;
        }
        if (node.type !== 'CallExpression') {
          return;
        }
        const found = calledKeyOf(node, file);
        problems.push(...found.problems);
        if (found.key !== null) {
          called.add(found.key);
        }
        const prefix = keyPrefixOf === null ? null : keyPrefixOf(node);
        if (prefix !== null) {
          keyPrefixes.add(prefix);
        }
      });
    }
  }
  // A key the source builds from the catalog has no literal of its own, so the
  // literals beside it stand in for it: `generic.body.` plus `chatMessage` is
  // `generic.body.chatMessage`. The literals are snapshotted once: a second
  // head must not prefix a key an earlier head already synthesized, since
  // `a.` then `b.` over the literal `c` would also yield `b.a.c`.
  const literals = [...referenced];
  for (const prefix of keyPrefixes) {
    for (const value of literals) {
      referenced.add(`${prefix}${value}`);
    }
  }
  return { called, referenced, destructiveKeys, problems, complete };
}

/**
 * The key one mobile `t()` call names, or null when the call is not a translate
 * call or carries no plain key. A template-literal key would make the both-ways
 * check unsound, so it fails instead of passing silently.
 */
function mobileCalledKey(call, file) {
  const problems = [];
  if (!isTranslateCallee(call.callee)) {
    return { key: null, problems };
  }
  const [first] = call.arguments;
  if (first === undefined) {
    return { key: null, problems };
  }
  const key = unwrap(first);
  if (key.type === 'TemplateLiteral') {
    problems.push(`${file}: t() called with a template literal; the key check cannot see it`);
    return { key: null, problems };
  }
  return { key: staticStringKey(first), problems };
}

/**
 * The push side of the uniform reader every catalog's scan calls: the key one
 * `translatePush(locale, key, …)` call names, wrapped in the
 * `{ key, problems }` shape `mobileCalledKey` writes. A push key is never a
 * template literal — the prefix below serves that form — so this reader has no
 * problem to report.
 */
function pushCalledKeyOf(call) {
  return { key: pushCalledKey(call), problems: [] };
}

/**
 * The key node of a `translatePush(locale, key, …)` call, unwrapped from its
 * TypeScript-only wrappers, or null when the call is not one or passes no key.
 * One reader decides what a translatePush call is, so the two key shapes below
 * cannot drift apart; each narrows the node it accepts.
 */
function translatePushKey(call) {
  if (call.callee.type !== 'Identifier' || call.callee.name !== 'translatePush') {
    return null;
  }
  const key = call.arguments[1];
  return key === undefined ? null : unwrap(key);
}

/**
 * The key one `translatePush(locale, key, …)` call names, or null when the call
 * is not one or its key is not a plain string.
 *
 * A non-literal key is the payload form the catalog exists to serve: two workers
 * build `` `${i18nKey}.title` `` and `` `${i18nKey}.body` `` from a field they
 * were handed, so nothing there names a key the catalog could miss and it passes
 * silently. The keys those payloads carry arrive as literals elsewhere in the
 * same tree.
 */
function pushCalledKey(call) {
  const value = translatePushKey(call);
  if (value === null) {
    return null;
  }
  return staticStringKey(value);
}

/**
 * The static head of a `translatePush(locale, key, …)` key built as a template
 * literal, when that head names the dotted parent of the key:
 * `` `generic.body.${leaf}` `` reads `generic.body.`. A table of leaves builds
 * its key this way, so the leaf literals beside it name every key under the
 * head. Any other template literal — `` `${i18nKey}.title` ``, whose head is
 * empty — names no parent and returns null.
 */
function pushKeyPrefix(call) {
  const value = translatePushKey(call);
  if (value === null) {
    return null;
  }
  if (value.type !== 'TemplateLiteral' || value.expressions.length === 0) {
    return null;
  }
  const head = value.quasis[0].value.cooked;
  return typeof head === 'string' && head.endsWith('.') ? head : null;
}

/**
 * Fold a value for the destructive-label comparison: NFC, lower case, one
 * space, no edge space. Diacritics stay, because a locale that writes Cancel
 * with another accent has written a different word; the comparison asks
 * whether the reader sees the same button twice.
 *
 * The dotted capital is not a different word. Turkish writes the capital of
 * `i` as `İ` (U+0130), which `toLowerCase` spells `i` + U+0307, so `İptal`
 * would fold to `i̇ptal` and never match a value that spells `iptal` with a
 * plain `i`. The pair becomes that plain `i`.
 */
function foldDestructiveLabel(value) {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/\u0069\u0307/g, 'i')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The destructively painted keys, each mapped to `rejectContainingCancel`:
 * whether a label that merely CONTAINS this catalog's Cancel word is also
 * rejected.
 *
 * `destructive-confirm-dialog.tsx` paints the safe button with
 * `cancelLabel ?? t('common.cancel')`, so a confirmation that leaves the safe
 * button to the fallback shows two buttons reading Cancel when the confirm
 * label was translated with the Cancel word.
 *
 * Exact equality is the defect whatever English says: a red button reading only
 * Cancel is the second Cancel button. Every key that paints the red choice is
 * checked for it.
 *
 * English anchors only the wider contains test: "Cancel subscription" beside
 * "Cancel" is the shipped English pattern, so a locale may translate that label
 * with its own Cancel word as long as the label also names the action. A key
 * whose English value is the bare Cancel word anchors nothing new — English
 * paints Cancel twice itself — so it takes the same exemption. A key missing
 * from English is not checked here; the parity rule reports it.
 */
function destructiveConfirmKeys(source, english) {
  const checks = new Map();
  const englishCancel = foldDestructiveLabel(english.get('common.cancel') ?? '');
  for (const key of source.destructiveKeys) {
    const englishValue = english.get(key);
    if (englishValue === undefined) {
      continue;
    }
    checks.set(
      key,
      englishCancel !== '' && !foldDestructiveLabel(englishValue).includes(englishCancel)
    );
  }
  return checks;
}

/**
 * Reject a destructive button whose label reads as this catalog's Cancel word.
 * It folds both labels, rejects an exact match for every key, and rejects a
 * match that only contains the Cancel word when `rejectContainingCancel` is
 * true; `destructiveConfirmKeys` computes that flag.
 */
function checkDestructiveConfirmLabel(label, key, value, cancelValue, rejectContainingCancel) {
  const problems = [];
  if (cancelValue === undefined) {
    return problems;
  }
  const cancel = foldDestructiveLabel(cancelValue);
  if (cancel === '') {
    return problems;
  }
  const folded = foldDestructiveLabel(value);
  if (folded !== cancel && !(rejectContainingCancel && folded.includes(cancel))) {
    return problems;
  }
  problems.push(
    `${label}: "${key}" reads "${value}", which this catalog already uses for Cancel ("${cancelValue}"); the destructive button must use a verb the locale does not use for Cancel`
  );
  return problems;
}

/**
 * The scripts one catalog may write in. Latin rides along everywhere for
 * product names and abbreviations; every other script must be the catalog's
 * own. A catalog that mixes two alphabets reads as two different languages —
 * Serbian shipped Latin copy beside Cyrillic strays for exactly that reason.
 */
const SCRIPT_PATTERNS = {
  Latin: /\p{Script=Latin}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
  Arabic: /\p{Script=Arabic}/u,
  Greek: /\p{Script=Greek}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Devanagari: /\p{Script=Devanagari}/u,
  Han: /\p{Script=Han}/u,
  Hangul: /\p{Script=Hangul}/u,
  Hiragana: /\p{Script=Hiragana}/u,
  Katakana: /\p{Script=Katakana}/u,
  Thai: /\p{Script=Thai}/u,
  Armenian: /\p{Script=Armenian}/u,
  Georgian: /\p{Script=Georgian}/u,
  Bengali: /\p{Script=Bengali}/u,
  Tamil: /\p{Script=Tamil}/u,
  Telugu: /\p{Script=Telugu}/u,
  Gujarati: /\p{Script=Gujarati}/u,
  Gurmukhi: /\p{Script=Gurmukhi}/u,
  Kannada: /\p{Script=Kannada}/u,
  Malayalam: /\p{Script=Malayalam}/u,
  Oriya: /\p{Script=Oriya}/u,
  Sinhala: /\p{Script=Sinhala}/u,
  Myanmar: /\p{Script=Myanmar}/u,
  Khmer: /\p{Script=Khmer}/u,
  Lao: /\p{Script=Lao}/u,
  Ethiopic: /\p{Script=Ethiopic}/u,
};

const SCRIPT_ENTRIES = Object.entries(SCRIPT_PATTERNS);

/** Languages whose own orthography needs more than one script. */
const MULTI_SCRIPT_LANGUAGES = { ja: ['Hiragana', 'Katakana', 'Han'] };

/**
 * The script of each character already resolved. A letter matches the first few
 * entries, but a space, digit, punctuation mark or placeholder brace matches
 * none and would pay the whole table on every appearance; the answer depends
 * only on the character, so it is looked up once. `null` is the "no script
 * claims it" answer, cached with the rest.
 */
const SCRIPT_OF_CHARACTER = new Map();

function scriptOf(char) {
  const known = SCRIPT_OF_CHARACTER.get(char);
  if (known !== undefined) {
    return known;
  }
  let name = null;
  for (const [candidate, pattern] of SCRIPT_ENTRIES) {
    if (pattern.test(char)) {
      name = candidate;
      break;
    }
  }
  SCRIPT_OF_CHARACTER.set(char, name);
  return name;
}

/** Every script in `values`, counted, so the dominant one can be picked. */
function scriptCounts(values) {
  const counts = new Map();
  for (const value of values) {
    for (const char of value) {
      const name = scriptOf(char);
      if (name) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Fold a value for wording comparison: case, edge space and end punctuation. */
function wording(value, language = 'en') {
  return value
    .trim()
    .toLocaleUpperCase(language)
    .toLocaleLowerCase(language)
    .replace(/[.!:。！：।॥]+$/u, '');
}

function pluralBaseKey(key) {
  return pluralParts(key)?.base ?? key;
}

/**
 * The key a push payload names when the runtime appends the part it renders.
 * A worker is handed `internal.lowBalance` and builds `…title` and `…body` from
 * it, so a source file that names the bare key has used every part the catalog
 * defines under it.
 */
function pushBaseKey(key) {
  return key.replace(/\.(?:title|body)$/, '');
}

/**
 * The placeholders a counted family uses for the number it counts: the
 * interpolated figure (`displayCount`, `itemCount`), i18next's own `count`,
 * which selects the plural category and can also be read into the message, and
 * the one family that names its figure itself (`steps`). Only a reviewed worded
 * form may drop one of them.
 */
const COUNT_PLACEHOLDERS = new Set(['count', 'displayCount', 'itemCount', 'steps']);

/** Placeholder sets already built, per English catalog and family base. */
const FAMILY_PLACEHOLDERS = new WeakMap();

/**
 * Every `{{token}}` an English plural family uses, across the base key and all
 * of its categories. A language may need one of those tokens in a category
 * where English spells the number out: English's `_one` only ever renders at 1,
 * but Serbian, Croatian, Bosnian, Russian, Ukrainian, Belarusian, Macedonian,
 * Lithuanian, Latvian, Icelandic, Filipino and Slovene also select their
 * singular form for 21, 101 and the like, so their `_one` value has to
 * interpolate the count. A category may therefore add a token its English
 * family already uses; it may never drop one English requires in that category.
 *
 * The set depends only on the English map and the base, so it is built once per
 * catalog and base and read afterwards: the locale loop asks for the same few
 * bases once per added plural category and once per placeholder mismatch.
 * Callers treat a returned set as read-only.
 */
function familyPlaceholders(english, base) {
  let families = FAMILY_PLACEHOLDERS.get(english);
  if (families === undefined) {
    families = new Map();
    FAMILY_PLACEHOLDERS.set(english, families);
  }
  const known = families.get(base);
  if (known !== undefined) {
    return known;
  }
  const tokens = new Set();
  for (const [key, value] of english) {
    if (key !== base && pluralBaseKey(key) !== base) {
      continue;
    }
    for (const token of placeholderTokens(value)) {
      tokens.add(token);
    }
  }
  families.set(base, tokens);
  return tokens;
}

/**
 * The visible-count placeholders an English family declares, e.g.
 * `displayCount`. A translated form must carry each one unless a reviewed
 * worded form spells the number out instead.
 */
function familyVisibleCounts(english, base) {
  return new Set(
    [...familyPlaceholders(english, base)].filter(name => COUNT_PLACEHOLDERS.has(name))
  );
}

/**
 * Whether a plural category's placeholder set is English's plus tokens from its
 * own family. `actualTokens` and `expectedTokens` are the category's own
 * `{{token}}` lists, one element per placeholder. Returns false for a non-plural
 * key, for a dropped required token, and for a token no value of the family uses.
 */
function addsFamilyPlaceholderOnly(english, key, actualTokens, expectedTokens) {
  const parts = pluralParts(key);
  if (!parts) {
    return false;
  }
  const required = new Set(expectedTokens);
  const used = new Set(actualTokens);
  if (used.size <= required.size) {
    return false;
  }
  for (const token of required) {
    if (!used.has(token)) {
      return false;
    }
  }
  const family = familyPlaceholders(english, parts.base);
  for (const token of used) {
    if (!family.has(token)) {
      return false;
    }
  }
  return true;
}

/**
 * The push runtime resolves a token locale and reads translations from one
 * registry. Its imports and that registry are hand-written, so this check holds
 * them together with the catalog folder: every catalog file of a supported
 * language is imported, every import is in the registry, and the registry names
 * nothing else. A tag outside the supported-language list is the membership
 * rule's finding, so it is owed neither an import nor a registry entry. A
 * catalog that only sat in the folder used to render in English with no gate
 * saying so; a registry entry with no import would translate nothing.
 */
function checkPushLocaleRegistry({ root, catalog, present, supported }) {
  const problems = [];
  const catalogDir = catalog.dir;
  const localeModule = catalog.localeRegistry;
  const relativeModule = relativePath(root, localeModule);
  const importPrefix =
    './' + relativePath(dirname(localeModule), catalogDir).split(sep).join('/') + '/';
  if (!existsSync(localeModule)) {
    problems.push(`${catalog.name}: no push locale registry at ${relativeModule}`);
    return problems;
  }
  const read = readAuditText(localeModule, catalog.name, 'the push locale registry');
  problems.push(...read.problems);
  if (read.text === null) {
    return problems;
  }
  const entry = parseSourceEntry(root, root, localeModule, read.text);
  if (entry.problems.length > 0) {
    // The tree a failed parse yields is not the one the walk below reads, so
    // "no push locale registry" would repeat the cause the parse error already
    // names.
    return [...problems, ...entry.problems];
  }

  const imported = new Map();
  const registered = new Map();
  let registryFound = false;
  walk(entry.program, node => {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      if (
        typeof source === 'string' &&
        source.startsWith(importPrefix) &&
        source.endsWith('.json')
      ) {
        const tag = source.slice(importPrefix.length, -'.json'.length);
        const binding = node.specifiers.find(
          specifier => specifier.type === 'ImportDefaultSpecifier'
        );
        imported.set(tag, binding ? binding.local.name : null);
      }
      return;
    }
    if (
      node.type !== 'VariableDeclarator' ||
      node.id.type !== 'Identifier' ||
      node.id.name !== 'pushCatalogs'
    ) {
      return;
    }
    registryFound = true;
    if (node.init === null) {
      problems.push(`${relativeModule}: the push locale registry has no initializer`);
      return;
    }
    const init = unwrap(node.init);
    if (init?.type !== 'ObjectExpression') {
      problems.push(`${relativeModule}: the push locale registry is not an object literal`);
      return;
    }
    for (const property of init.properties) {
      if (property.type !== 'Property') {
        problems.push(`${relativeModule}: the push locale registry contains a ${property.type}`);
        continue;
      }
      const key = unwrap(property.key);
      let tag;
      if (key.type === 'Identifier') {
        tag = key.name;
      } else if (key.type === 'Literal' && typeof key.value === 'string') {
        tag = key.value;
      } else {
        problems.push(
          `${relativeModule}: the push locale registry has a key this check cannot read`
        );
        continue;
      }
      const value = unwrap(property.value);
      if (value.type !== 'Identifier') {
        problems.push(
          `${relativeModule}: the push locale registry entry "${tag}" is not a catalog import`
        );
        continue;
      }
      registered.set(tag, value.name);
    }
  });
  if (!registryFound) {
    problems.push(`${relativeModule}: no push locale registry named "pushCatalogs"`);
    return problems;
  }

  for (const tag of [...present].sort()) {
    if (supported !== null && !supported.has(tag)) {
      continue;
    }
    if (!imported.has(tag)) {
      problems.push(`${catalog.name}: catalog "${tag}.json" has no import in ${relativeModule}`);
    }
    if (!registered.has(tag)) {
      problems.push(`${catalog.name}: catalog "${tag}.json" has no push locale registry entry`);
    }
  }
  for (const tag of [...imported.keys()].sort()) {
    if (!present.has(tag)) {
      problems.push(
        `${catalog.name}: ${relativeModule} imports "${importPrefix}${tag}.json" with no catalog file`
      );
    }
  }
  for (const [tag, binding] of [...registered].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
  )) {
    if (!imported.has(tag)) {
      problems.push(
        `${catalog.name}: the push locale registry names "${tag}" with no catalog import`
      );
      continue;
    }
    if (binding !== imported.get(tag)) {
      problems.push(
        `${catalog.name}: the push locale registry binds "${tag}" to "${binding}" instead of the "${tag}" catalog import`
      );
    }
  }
  return problems;
}

/**
 * Whether a translated-only key is an admitted member of an English plural
 * family: it ends in a category, and English declares that family or counts
 * through a `{{count}}` base for it. The extra-key rule skips such a key and the
 * placeholder rule validates it, so one predicate decides both.
 */
function isAdmittedPluralKey(parts, englishFamilies, englishCountedBases) {
  return parts !== null && (englishFamilies.has(parts.base) || englishCountedBases.has(parts.base));
}

/** The catalogs a folder is missing, and the files no supported language names. */
function checkCatalogMembership({ catalogName, tags, present, dir }) {
  const problems = [];
  for (const tag of tags) {
    if (!present.has(tag)) {
      problems.push(`${catalogName}: no catalog for supported language "${tag}"`);
    }
  }
  for (const tag of present) {
    if (!tags.includes(tag)) {
      problems.push(`${catalogName}: catalog "${tag}.json" is not a supported language`);
    }
  }
  // `catalogTags` counts only regular files, so a directory named like a
  // catalog would vanish from `present` and from this rule without a trace.
  // Naming it here keeps the stray entry a reported problem instead, which is
  // why this reader rejects the other kind.
  for (const name of catalogEntryNames(dir, 'file')) {
    problems.push(
      `${catalogName}: catalog "${name}.json" is not a regular file; remove it or make it a catalog`
    );
  }
  return problems;
}

function checkEnglishCopies({ catalogName, english }) {
  const problems = [];
  // Every plural key is exempt, not only the members of one family. So two
  // plural families holding the same copy pass here. That is deliberate: the
  // one-wording rule below groups plural keys too, so the catalogs still cannot
  // drift apart, and only the duplicate key survives. Narrowing the exemption
  // has to compare stems, because a family's bare key carries its `_other` copy
  // by i18next convention and is not a second key for the same string.
  const byCopy = new Map();
  for (const [key, value] of english) {
    if (pluralParts(key)) {
      continue;
    }
    if (!byCopy.has(value)) {
      byCopy.set(value, []);
    }
    byCopy.get(value).push(key);
  }
  for (const [value, keys] of byCopy) {
    if (keys.length < 2 || keys.every(key => PER_LINE_BUCKET_PHRASES.has(pluralBaseKey(key)))) {
      continue;
    }
    const folded = wording(value);
    if (TWO_SENSE_COPY.has(folded)) {
      continue;
    }
    // The remedy prints the folded form, because that is the one the exemption
    // lookup compares; adding the raw copy would not exempt it.
    const foldNote =
      folded === value
        ? ''
        : ' (entries are compared after trimming, case folding and dropping trailing sentence punctuation)';
    problems.push(
      `${catalogName}/en: ${keys.length} keys hold the copy "${value}" (${keys.join(', ')}). Point every call site at one key, or add "${folded}" to TWO_SENSE_COPY in tools/i18n/check-catalogs.mjs${foldNote} with the two senses it carries.`
    );
  }
  return problems;
}

/**
 * Whether a value is serialized JSON rather than the copy it should read:
 * JSON.parse accepts the trimmed text. A scalar ("42", "true", "null") parses
 * too, and a label one of those encodes is a storage slip all the same. A
 * `{{placeholder}}` carries braces but never parses, so copy keeps it.
 */
function isSerializedJson(value) {
  try {
    JSON.parse(value.trim());
  } catch {
    return false;
  }
  return true;
}

/**
 * The one key whose text is a JSON sample by design: the MCP form's multiline
 * config placeholder shows the shape the stored value takes, so its braces and
 * quoted key are the content, not a storage slip. It is registered in
 * `VERBATIM_KEYS` too, because `checkVerbatimLabels` requires the English text.
 * Every other key, verbatim or not, still fails a serialized value. The
 * verbatim rule reads a locale against the English reference, so it cannot see
 * a deviation in the English catalog itself, and the storage-slip rule is the
 * only guard there.
 */
const JSON_SAMPLE_KEY = 'profiles.mcp.jsonPlaceholder';

/** Reject a catalog value that a JSON encoder wrote instead of a label. */
function checkSerializedJson(label, key, value) {
  // Only the JSON sample is JSON text by design; every other label must be prose.
  if (key === JSON_SAMPLE_KEY || !isSerializedJson(value)) {
    return [];
  }
  return [`${label}: "${key}" is serialized JSON; write the label text`];
}

/** The value rules English itself must pass. */
function checkEnglishValues({ catalogName, english, englishValues }) {
  const problems = [];
  // English exempts nothing: a label it spells is a label it can name.
  const ownValues = new Set();
  for (const [key, value] of english) {
    if (value.trim() === '') {
      problems.push(`${catalogName}/en: "${key}" is empty`);
    }
    problems.push(...checkSerializedJson(`${catalogName}/en`, key, value));
    for (const ref of nestingRefs(value)) {
      if (!english.has(ref)) {
        problems.push(
          `${catalogName}/en: "${key}" names $t(${ref}), which en.json does not define`
        );
      }
    }
    // English must not spell a label it can name, or every translator copies
    // the English word into a sentence they otherwise translated.
    for (const run of quotedLabelRuns({ value, englishValues, ownValues })) {
      problems.push(
        `${catalogName}/en: "${key}" quotes the label "${run}"; name its key with $t()`
      );
    }
  }
  return problems;
}

/** The English side of one catalog, in emission order. */
function checkEnglishCatalog({ catalogName, english, englishValues }) {
  const label = `${catalogName}/en`;
  return [
    ...checkEnglishValues({ catalogName, english, englishValues }),
    ...checkVisibilitySeparators(english, label),
    ...checkPullRequestTerm(english, label),
    ...checkChangelogAreaLabels('en', english, label),
  ];
}

/** The keys a locale owes English, then the keys English does not name. */
function checkKeyParity({
  label,
  tag,
  selectableCategories,
  englishFacts,
  translated,
  localeFamilies,
}) {
  const { english, families: englishFamilies, countedBases: englishCountedBases } = englishFacts;
  const problems = [];
  const selectable = selectableCategories(tag);
  for (const key of english.keys()) {
    if (translated.has(key)) {
      continue;
    }
    const parts = pluralParts(key);
    if (parts && !selectable.has(parts.category)) {
      // The locale can never select this category, so it owes no such form:
      // the key would be copy no reader of this language sees. A `_zero`
      // member stays owed, because i18next looks that suffix up itself.
      continue;
    }
    if (
      parts &&
      englishFamilies.has(parts.base) &&
      !localeFamilies.has(parts.base) &&
      translated.has(parts.base)
    ) {
      // The locale kept the flat base key of a counted English family; it
      // owes no categories for that family, so they are deliberately not
      // reported. Only a non-counted English family reports below.
      continue;
    }
    problems.push(`${label}: missing key "${key}"`);
  }
  for (const key of translated.keys()) {
    if (english.has(key)) {
      continue;
    }
    const parts = pluralParts(key);
    if (isAdmittedPluralKey(parts, englishFamilies, englishCountedBases)) {
      continue;
    }
    problems.push(`${label}: extra key "${key}" is not in en.json`);
  }
  return problems;
}

/**
 * The categories a locale's plural families lack, judged by the categories its
 * catalog's runtime can both require and render.
 *
 * This rule demands a form and the unreachable-form rule rejects one, so the two
 * must read one truth source or they can contradict each other: a category the
 * host requires but the runtime cannot select would be demanded by one rule and
 * rejected by the other, leaving the audit unsatisfiable. The required list is
 * therefore the intersection of the host's categories and the catalog's own
 * selectable set, and it keeps `zero` wherever the host list carries it: a
 * language that selects that category itself (Arabic, Welsh, Latvian) still owes
 * its `_zero` form.
 *
 * The demand therefore never includes a form the runtime cannot render. It also
 * cannot demand a category only the shipped data selects, so a family a locale
 * declares under a flat counted English key is not asked for that form; a
 * family English declares is still covered by the key-parity rule.
 */
function checkPluralCategories({ label, tag, englishFacts, translated, selectableCategories }) {
  const { english } = englishFacts;
  const problems = [];
  const host = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  const selectable = selectableCategories(tag);
  // The intersection, with no separate `zero` rule: `zero` is in the host list
  // only for a language that really selects it (Arabic, Welsh, Latvian), so a
  // family of one of those still owes its `_zero` form. For every other
  // language the host list has no `zero` to carry through.
  const required = host.filter(category => selectable.has(category));
  for (const [family, absent] of missingPluralCategories(english, translated, tag, required)) {
    for (const category of absent) {
      problems.push(`${label}: plural family "${family}" lacks the ${category} category of ${tag}`);
    }
  }
  return problems;
}

/**
 * The plural forms no reader of this language can see: a form whose category
 * the runtime never selects for this tag, and whose copy is identical to its
 * family's `other` copy.
 *
 * Both conditions are needed before the rule names a line. The first says the
 * runtime does not pick this form; the second says that even a runtime which
 * does pick it renders exactly the same text, so the entry is a duplicate of
 * copy its family already carries. A form with text of its own is left alone,
 * because a runtime the audit does not measure may select it. `zero` is never
 * reported: i18next consults it directly at a zero count.
 */
function checkUnselectablePluralCategories({ label, tag, translated, selectableCategories }) {
  const problems = [];
  for (const [family, categories] of unselectablePluralCategories(
    translated,
    selectableCategories(tag)
  )) {
    for (const category of categories) {
      problems.push(
        `${label}: plural family "${family}" declares a ${category} form that ${tag} never selects`
      );
    }
  }
  return problems;
}

/** The value rules every translated key passes, in emission order. */
function checkTranslatedValues({ label, tag, englishFacts, translated }) {
  const { english, destructiveChecks } = englishFacts;
  const problems = [];
  const ownValues = new Set(translated.values());
  for (const [key, value] of translated) {
    // The serialized-JSON rule needs no English reference: a locale's own
    // plural category (`agents.liveCount_few` of ar) never appears in en.json,
    // but a JSON object stored in it is the same storage slip.
    problems.push(...checkSerializedJson(label, key, value));
    if (!english.has(key)) {
      problems.push(
        ...checkAddedPluralForm({
          label,
          tag,
          englishFacts,
          key,
          value,
          ownValues,
        })
      );
      continue;
    }
    const englishValue = english.get(key);
    problems.push(
      ...checkTranslatedValue({
        label,
        tag,
        englishFacts,
        key,
        value,
        englishValue,
        ownValues,
        cancelValue: translated.get('common.cancel'),
        rejectContainingCancel: destructiveChecks.get(key),
      })
    );
  }
  return problems;
}

/**
 * A plural form the locale adds — a category English does not ship — passes the
 * same value rules as an English-keyed form, read against the family's English
 * reference for that category. A key that is not an admitted family member is
 * the extra-key rule's finding and passes nothing here.
 */
function checkAddedPluralForm({ label, tag, englishFacts, key, value, ownValues }) {
  const {
    english,
    families: englishFamilies,
    countedBases: englishCountedBases,
    values: englishValues,
  } = englishFacts;
  const problems = [];
  const parts = pluralParts(key);
  if (!isAdmittedPluralKey(parts, englishFamilies, englishCountedBases)) {
    return problems;
  }
  const englishRef =
    english.get(`${parts.base}_${parts.category}`) ??
    english.get(`${parts.base}_other`) ??
    english.get(parts.base) ??
    '';
  // Such a key is always a plural category, so no separator exemption applies:
  // an empty form renders nothing at that count.
  if (value.trim() === '') {
    problems.push(`${label}: "${key}" is empty`);
  }
  problems.push(
    ...checkValuePlaceholders({
      label,
      english,
      key,
      value,
      englishValue: englishRef,
      countsMayBeWorded:
        parts.category === 'zero' || WORDED_COUNTS.has(`${parts.base}:${parts.category}:${tag}`),
      requiredCounts: familyVisibleCounts(english, parts.base),
    })
  );
  problems.push(...checkValueEdges({ label, key, value, englishValue: englishRef }));
  problems.push(...checkQuotedLabels({ label, key, value, englishValues, ownValues }));
  return problems;
}

/** Every rule one translated key is read against. */
function checkTranslatedValue({
  label,
  tag,
  englishFacts,
  key,
  value,
  englishValue,
  ownValues,
  cancelValue,
  rejectContainingCancel,
}) {
  const { english, values: englishValues, mustTranslateKeys } = englishFacts;
  const problems = [];
  const separatorOnly =
    key === 'common.sentenceJoiner' && MARKLESS_SENTENCE_TAGS.has(tag) && value !== '';
  if (value.trim() === '' && !separatorOnly) {
    problems.push(`${label}: "${key}" is empty`);
  }
  if (rejectContainingCancel !== undefined) {
    problems.push(
      ...checkDestructiveConfirmLabel(label, key, value, cancelValue, rejectContainingCancel)
    );
  }
  if (mustTranslateKeys.has(key) && value === englishValue) {
    problems.push(`${label}: "${key}" must be translated`);
  }
  const parts = pluralParts(key);
  problems.push(
    ...checkValuePlaceholders({
      label,
      english,
      key,
      value,
      englishValue,
      countsMayBeWorded: Boolean(
        parts && WORDED_COUNTS.has(`${parts.base}:${parts.category}:${tag}`)
      ),
      requiredCounts: new Set(),
    })
  );
  problems.push(...checkValueEdges({ label, key, value, englishValue }));
  problems.push(...checkQuotedLabels({ label, key, value, englishValues, ownValues }));
  return problems;
}

/**
 * A quoted English label. The copy must name the label's key with `$t(key)`, or
 * the message points at a button this user never sees.
 */
function checkQuotedLabels({ label, key, value, englishValues, ownValues }) {
  return quotedLabelRuns({ value, englishValues, ownValues }).map(
    run => `${label}: "${key}" quotes the English label "${run}"; name its key with $t()`
  );
}

/**
 * The placeholder set, `$t()` references and `$TOKEN` tokens of one value.
 *
 * One rule reads both an English-keyed form and a plural form the locale adds,
 * and its two exemptions are explicit parameters rather than a second
 * implementation: `countsMayBeWorded` allows a dropped visible count (the
 * `zero` category, or a form `WORDED_COUNTS` reviewed), and `requiredCounts`
 * names the counts a form of the family must still carry. English-keyed keys
 * pass an empty set, so a dropped count is only ever the mismatch below.
 */
function checkValuePlaceholders({
  label,
  english,
  key,
  value,
  englishValue,
  countsMayBeWorded,
  requiredCounts,
}) {
  const problems = [];
  const expectedTokens = placeholderTokens(englishValue);
  const actualTokens = placeholderTokens(value);
  const expected = signature(expectedTokens);
  const actual = signature(actualTokens);
  const dropped = expectedTokens.filter(name => !actualTokens.includes(name));
  const added = actualTokens.some(name => !expectedTokens.includes(name));
  // A visible count the form must show and does not. `requiredCounts` comes
  // from the whole family, not from the reference, because a reference may
  // spell its own numeral out ("1 live session") while a sibling carries the
  // placeholder. The count reads as an age only when the language spells the
  // number out, so a form that drops it needs the reviewed worded form that
  // names its key, category and locale. A form that also uses a token the
  // family never uses is the mismatch below instead: its signature names both.
  const missingCounts =
    countsMayBeWorded || added
      ? []
      : [...requiredCounts].filter(name => !actualTokens.includes(name));
  for (const name of missingCounts) {
    problems.push(
      `${label}: "${key}" drops {{${name}}} without a reviewed worded form (WORDED_COUNTS)`
    );
  }
  // The set differs from the reference unless the difference is one the rules
  // already explain: a family token the form adds, a count it words under an
  // exemption, or a missing count the loop above has named. One defect keeps
  // one line, and the specific count line wins. An English-keyed key passes no
  // required count, so any drop is still this message.
  const explained =
    missingCounts.length > 0 ||
    (dropped.length > 0 &&
      !added &&
      dropped.every(name =>
        countsMayBeWorded ? COUNT_PLACEHOLDERS.has(name) : requiredCounts.has(name)
      ));
  if (
    actual !== expected &&
    !addsFamilyPlaceholderOnly(english, key, actualTokens, expectedTokens) &&
    !explained
  ) {
    problems.push(`${label}: "${key}" placeholders differ from English (${expected || 'none'})`);
  }
  const expectedRefs = nestingRefs(englishValue).join(',');
  if (nestingRefs(value).join(',') !== expectedRefs) {
    problems.push(
      `${label}: "${key}" $t() references differ from English (${expectedRefs || 'none'})`
    );
  }
  const expectedExpansions = expansionTokens(englishValue).join(',');
  if (expansionTokens(value).join(',') !== expectedExpansions) {
    problems.push(
      `${label}: "${key}" $TOKEN expansion tokens differ from English (${expectedExpansions || 'none'})`
    );
  }
  return problems;
}

/** The edge space, double space and direction marks of one value. */
function checkValueEdges({ label, key, value, englishValue }) {
  const problems = [];
  if (!carriesOwnEdges(key) && edges(value) !== edges(englishValue)) {
    problems.push(`${label}: "${key}" leading or trailing space differs from English`);
  }
  if (/ {2}/.test(value) && !/ {2}/.test(englishValue)) {
    problems.push(`${label}: "${key}" has a double space`);
  }
  if (/[\u200e\u200f\u202a-\u202e]/.test(value)) {
    problems.push(`${label}: "${key}" carries a direction mark; write plain text`);
  }
  return problems;
}

/** The space around the Terms link and its conjunction. */
function checkLoginSeparators({ label, tag, translated }) {
  const problems = [];
  // The separator keys are this catalog's only statement about how it joins
  // one word to the next, and they are allowed to differ from English on
  // purpose — so they have to agree with each other about the junction before
  // the Terms link: a padded prefix with a bare connector joins "our" to
  // "Terms" but runs the conjunction into the next noun; the reverse drops the
  // space before the link. The junction after the conjunction follows the
  // catalog's orthography. A catalog that abuts its words pads neither side
  // ("和"). One that separates words with spaces pads the conjunction's start,
  // and its end depends on how the language writes the conjunction: as a word
  // of its own (" and ") or, in the tags in `PREFIX_CONJUNCTION_TAGS`, as a
  // prefix letter that joins the noun it governs (" و").
  const prefixValue = translated.get('login.termsPrefix');
  const connectorValue = translated.get('login.termsConnector');
  if (prefixValue !== undefined && connectorValue !== undefined) {
    const paddedPrefix = /\s$/.test(prefixValue);
    const connectorLeads = /^\s/.test(connectorValue);
    if (paddedPrefix !== connectorLeads) {
      problems.push(
        `${label}: "login.termsPrefix" and "login.termsConnector" disagree about the space before the Terms link; pad the prefix and the conjunction's start together`
      );
    }
    const wantsPaddedEnd = paddedPrefix && !PREFIX_CONJUNCTION_TAGS.has(tag);
    if (/\s$/.test(connectorValue) !== wantsPaddedEnd) {
      const reason = !paddedPrefix
        ? 'this catalog abuts its words'
        : PREFIX_CONJUNCTION_TAGS.has(tag)
          ? 'this catalog writes the conjunction as a prefix of the next word'
          : 'this catalog writes the conjunction as a separate word';
      problems.push(
        `${label}: "login.termsConnector" must ${wantsPaddedEnd ? 'end with a space' : 'end without a space'}, because ${reason}`
      );
    }
  }
  return problems;
}

/** The sentence separator of the composed review message. */
function checkSentenceSeparator({ label, tag, translated }) {
  const problems = [];
  const freshForms = [...translated].filter(
    ([key]) => pluralBaseKey(key) === SENTENCE_SEPARATED_FAMILY
  );
  if (freshForms.length > 0) {
    const padded = freshForms.filter(([, value]) => /\s$/.test(value)).length;
    if (padded !== 0 && padded !== freshForms.length) {
      problems.push(
        `${label}: "${SENTENCE_SEPARATED_FAMILY}" family disagrees about its sentence separator; pad every form or none`
      );
    }
    const shouldPad = !UNSPACED_SENTENCE_TAGS.has(tag);
    if (padded > 0 !== shouldPad) {
      problems.push(
        `${label}: "${SENTENCE_SEPARATED_FAMILY}" must ${shouldPad ? 'end with a space' : 'end without a space'}, which is how ${tag} separates two sentences`
      );
    }
  }
  return problems;
}

function checkCatalogScript({ label, tag, translated }) {
  const problems = [];
  // One alphabet per catalog.
  const counts = scriptCounts(translated.values());
  const allowed = new Set(MULTI_SCRIPT_LANGUAGES[tag] ?? []);
  if (allowed.size === 0) {
    // The catalog's own script is its largest non-Latin one, but only when
    // it carries a real share of the letters. Latin rides along in every
    // catalog through product names and placeholders, so a bare "most
    // frequent" rule would call a short Korean catalog Latin — while a
    // Latin catalog holding a handful of Cyrillic look-alike letters (a
    // Cyrillic "а" inside a Latin word) would adopt Cyrillic and pass.
    const letters = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const [own] = [...counts]
      .filter(([name, n]) => name !== 'Latin' && n >= letters * 0.05)
      .sort((a, b) => b[1] - a[1])[0] ?? ['Latin'];
    allowed.add(own);
  }
  allowed.add('Latin');
  const strayScripts = [...counts.keys()].filter(name => !allowed.has(name));
  if (strayScripts.length > 0) {
    const examples = [...translated]
      .filter(([, value]) => [...value].some(char => strayScripts.includes(scriptOf(char))))
      .slice(0, 3)
      .map(([key]) => key);
    problems.push(
      `${label}: writes ${strayScripts.join(' and ')} beside ${[...allowed].join(' and ')} (e.g. ${examples.join(', ')}); keep one alphabet`
    );
  }
  return problems;
}

function checkSharedWordings({ label, tag, translated, sharedWordings, wordingExceptions }) {
  const problems = [];
  // One wording per English string.
  const exceptions = new Set(wordingExceptions[tag] ?? []);
  for (const [source, keys] of sharedWordings) {
    if (
      exceptions.has(source) ||
      keys.every(key => PER_LINE_BUCKET_PHRASES.has(pluralBaseKey(key)))
    ) {
      continue;
    }
    const variants = new Map();
    // A plural family's own categories carry this language's forms for the
    // counts it distinguishes, so they differ by design. One member of each
    // family speaks for it here: its flat base key when the group has one,
    // otherwise its first category.
    const representative = new Map();
    for (const key of [...keys].sort(
      (a, b) => Number(pluralParts(a) !== null) - Number(pluralParts(b) !== null)
    )) {
      const base = pluralBaseKey(key);
      if (!representative.has(base)) {
        representative.set(base, key);
      }
    }
    for (const key of representative.values()) {
      const value = translated.get(key);
      if (value === undefined) {
        continue;
      }
      const folded = wording(value, tag);
      if (!variants.has(folded)) {
        variants.set(folded, key);
      }
    }
    if (variants.size > 1) {
      const shown = [...variants].map(([value, key]) => `"${value}" (${key})`).join(' vs ');
      problems.push(
        `${label}: English "${source}" is translated ${variants.size} ways: ${shown}. Pick one, or list the English string in tools/i18n/wording-exceptions.json under "${tag}".`
      );
    }
  }
  return problems;
}

/**
 * Every locale of one catalog that the supported-language list names, in the
 * folder's order. A tag outside that list is the membership rule's finding, not
 * this audit's, so it is not read here.
 */
function checkCatalogLocales({
  catalog,
  selectableCategories,
  present,
  supported,
  englishFacts,
  sharedWordings,
  wordingExceptions,
}) {
  const { english } = englishFacts;
  const problems = [];
  const catalogName = catalog.name;
  const localeValues = new Map();

  for (const tag of present) {
    if (tag === 'en' || (supported !== null && !supported.has(tag))) {
      continue;
    }
    const label = `${catalogName}/${tag}`;
    // A tag `Intl` refuses is structurally invalid, not merely unknown: the
    // same tag makes `wording()`'s `toLocaleUpperCase(tag)` throw, so nothing
    // locale-sensitive may receive it. One line, then the tag is skipped.
    try {
      new Intl.PluralRules(tag);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${label}: cannot audit catalog: ${message}`);
      continue;
    }
    const parsed = parseCatalog(join(catalog.dir, `${tag}.json`), label);
    problems.push(...parsed.problems);
    const translated = parsed.catalog;
    if (translated === null) {
      continue;
    }
    localeValues.set(tag, translated);
    problems.push(...checkAgentEditorCopy(translated, english, label));
    problems.push(...checkPullRequestTerm(translated, label));
    problems.push(...checkArmenianSentenceTerminator(tag, translated, label));
    problems.push(...checkUrduSentenceTerminator(translated, label));
    problems.push(...checkBorrowedDanda(translated, label));
    problems.push(...checkChangelogAreaLabels(tag, translated, label));

    // The families this locale declares itself, through a member key with a
    // category suffix. The English siblings of a family English declares stay
    // mandatory in the missing-key rule below, except where the locale carries
    // the flat base key instead, and except a category this tag can never
    // select: a Japanese catalog owes no `_one` form, because i18next never
    // asks for one there.
    const localeFamilies = pluralFamilyBases(translated);
    problems.push(
      ...checkKeyParity({
        label,
        tag,
        englishFacts,
        translated,
        localeFamilies,
        selectableCategories,
      })
    );
    problems.push(
      ...checkPluralCategories({ label, tag, englishFacts, translated, selectableCategories })
    );
    problems.push(
      ...checkUnselectablePluralCategories({ label, tag, translated, selectableCategories })
    );
    problems.push(
      ...checkTranslatedValues({
        label,
        tag,
        englishFacts,
        translated,
      })
    );
    problems.push(...checkLoginSeparators({ label, tag, translated }));
    problems.push(...checkSentenceSeparator({ label, tag, translated }));
    problems.push(...checkCatalogScript({ label, tag, translated }));
    problems.push(
      ...checkSharedWordings({ label, tag, translated, sharedWordings, wordingExceptions })
    );
  }

  return { problems, localeValues };
}

function checkMobileEnglishIdentical({ catalogName, english, localeValues }) {
  const problems = [];
  // A mobile key whose value equals English in every non-English locale was
  // never translated. Allowlist the proper nouns and format-only strings that
  // are legitimately identical. Only a catalog that was read can say a key was
  // never translated, so an unreadable one is left out.
  if (localeValues.size === 0) {
    return problems;
  }
  for (const [key, englishValue] of english) {
    if (expectsEnglishCopy(key)) {
      continue;
    }
    // A value with prose of its own is judged per locale by
    // checkMobileLocaleEnglishCopy, which also applies MOBILE_ENGLISH_COPY_EXCEPTIONS.
    // This rule is the only reporter for a value with no prose to translate:
    // a placeholder-only string or a capitalised product name that no locale
    // changed. Reporting a prose value here as well would name one defect twice.
    if (carriesEnglishProse(englishValue)) {
      continue;
    }
    let allEqual = true;
    for (const translated of localeValues.values()) {
      if (translated.get(key) !== englishValue) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) {
      problems.push(`${catalogName}: "${key}" equals English in every locale`);
    }
  }
  return problems;
}

function checkMobileLocaleEnglishCopy({ catalogName, english, localeValues }) {
  const problems = [];
  // The every-locale rule above stays silent about a key that one catalog
  // translated and another left in English, because the value differs between
  // locales. Judge each catalog on its own: a value that still equals English
  // and carries prose of its own was not translated there, unless the key is
  // allowlisted or the catalog lists that exact value in
  // MOBILE_ENGLISH_COPY_EXCEPTIONS. An unreadable catalog carries no values, so
  // it says nothing here.
  if (localeValues.size === 0) {
    return problems;
  }
  for (const [tag, translated] of localeValues) {
    for (const [key, englishValue] of english) {
      if (translated.get(key) !== englishValue) {
        continue;
      }
      if (expectsEnglishCopy(key)) {
        continue;
      }
      if (!carriesEnglishProse(englishValue)) {
        continue;
      }
      if (Object.hasOwn(MOBILE_ENGLISH_COPY_EXCEPTIONS[tag] ?? {}, englishValue)) {
        continue;
      }
      problems.push(
        `${catalogName}/${tag}: "${key}" is English; translate it, or list the value for "${tag}" in MOBILE_ENGLISH_COPY_EXCEPTIONS`
      );
    }
  }
  return problems;
}

function checkPushEnglishCopy({ catalogName, english, localeValues }) {
  const problems = [];
  // Push copy is short, and a value that still reads as English was never
  // translated. A single token carries no grammar — a product name or a bare
  // placeholder has nothing to translate — so only a value with words is
  // judged.
  for (const [key, englishValue] of english) {
    if (englishValue.trim().split(/\s+/).length < 2) {
      continue;
    }
    for (const [tag, translated] of localeValues) {
      if (translated.get(key) !== englishValue) {
        continue;
      }
      if ((NOTIFICATIONS_ENGLISH_COPY_EXCEPTIONS[tag] ?? []).includes(englishValue)) {
        continue;
      }
      problems.push(
        `${catalogName}/${tag}: "${key}" is English; translate it, or list the value in NOTIFICATIONS_ENGLISH_COPY_EXCEPTIONS under "${tag}"`
      );
    }
  }
  return problems;
}

/**
 * Every key the source names exists, and every English key is used.
 *
 * The first rule holds either way: a key the source calls and English does not
 * define is a real gap, and a scan that missed a file cannot excuse it.
 *
 * The second rule needs a complete scan. A file the scan could not read or
 * parse left its keys out of `referenced`, so reporting an English key as
 * unused would call a live key dead — a fix that deletes copy a screen still
 * renders. An incomplete scan therefore proves no key dead and names none; its
 * own problem lines already say why, which is the same reason
 * `findOrphanedNoAgreementEntries` in tools/i18n/check-plurals.mjs drops its
 * per-key lines for a scan with problems.
 *
 * The guard reads `source.complete`, not `source.problems.length`. A `t()` call
 * with a template-literal key reports a problem but leaves its file read and
 * parsed, so nothing is invisible there and the dead-key rule must keep
 * running for every other key; a coarse problem count would silently disable
 * the rule for a whole catalog whenever one call took a template literal.
 */
function checkSourceUsage({ catalogName, english, source, baseKeyOf, englishFamilies }) {
  const problems = [];
  for (const key of source.called) {
    if (!english.has(key) && !englishFamilies.has(key)) {
      problems.push(`${catalogName}: source uses "${key}", which en.json does not define`);
    }
  }
  if (!source.complete) {
    return problems;
  }
  for (const key of english.keys()) {
    if (!source.referenced.has(key) && !source.referenced.has(baseKeyOf(key))) {
      problems.push(`${catalogName}: en.json defines "${key}", which no source file uses`);
    }
  }
  return problems;
}

/**
 * The four severity levels, as the two catalogs name them: the key the push
 * title reads, then the key the app's finding rows read. The push titles and
 * the app show the same level, so one language must spell it the same way in
 * both places.
 */
const SEVERITY_WORDING_PAIRS = [
  ['internal.securityFindingSeverity.critical', 'common.critical'],
  ['internal.securityFindingSeverity.high', 'securityAgent.sla.high'],
  ['internal.securityFindingSeverity.medium', 'securityAgent.sla.medium'],
  ['internal.securityFindingSeverity.low', 'securityAgent.sla.low'],
];

/**
 * One severity level, one word, in both catalogs.
 *
 * The push title renders a level through the push catalog, and the app's
 * finding rows render the same level through the mobile catalog. A language
 * that spells a level two ways shows one reader two words for one finding, so
 * every pair in `SEVERITY_WORDING_PAIRS` must read the same. English is
 * compared first, then every tag both catalogs carry; a tag only one of them
 * has holds nothing to compare.
 *
 * A pair either side does not define is skipped: a fixture tree carries partial
 * catalogs, and the missing-key rules already report a real gap. A problem line
 * names both keys and both values, so the developer can fix either side.
 */
function checkSeverityWordingParity(parsedCatalogs) {
  const problems = [];
  const mobile = parsedCatalogs.get('mobile');
  const notifications = parsedCatalogs.get('notifications');
  if (mobile === undefined || notifications === undefined) {
    return problems;
  }
  const views = [['en', notifications.english, mobile.english]];
  for (const [tag, pushValues] of notifications.localeValues) {
    const mobileValues = mobile.localeValues.get(tag);
    if (mobileValues !== undefined) {
      views.push([tag, pushValues, mobileValues]);
    }
  }
  for (const [tag, pushValues, mobileValues] of views) {
    for (const [pushKey, mobileKey] of SEVERITY_WORDING_PAIRS) {
      const pushWord = pushValues.get(pushKey);
      const mobileWord = mobileValues.get(mobileKey);
      if (pushWord === undefined || mobileWord === undefined || pushWord === mobileWord) {
        continue;
      }
      problems.push(
        `notifications/${tag}: "${pushKey}" reads "${pushWord}" but mobile "${mobileKey}" reads "${mobileWord}"`
      );
    }
  }
  return problems;
}

/**
 * The English strings each catalog may render more than one way, and the
 * problem that stopped the audit from reading them. A file that is missing,
 * does not parse, or does not map each tag to a list of strings reports the
 * same one line: the callers below read every tag's entry as a set, so a value
 * of another shape must not reach them, and a fixture tree still gets the rest
 * of the findings.
 */
function readWordingExceptions(root) {
  const problems = [];
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, 'tools/i18n/wording-exceptions.json'), 'utf8')
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every(
        entries => Array.isArray(entries) && entries.every(entry => typeof entry === 'string')
      )
    ) {
      return { wordingExceptions: parsed, problems };
    }
    problems.push(
      'check-catalogs: cannot read tools/i18n/wording-exceptions.json: ' +
        'expected an object that maps each tag to a list of English strings'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`check-catalogs: cannot read tools/i18n/wording-exceptions.json: ${message}`);
  }
  return { wordingExceptions: {}, problems };
}

/**
 * Every problem the catalogs under `root` have, and how many languages were
 * checked. The repository root is the default, so the CLI below and a test that
 * points at a fixture tree run the same audit. The findings are returned, not
 * kept in module state, so one call's problems cannot leak into the next.
 */
export function checkCatalogs(root = ROOT) {
  const problems = [];
  /**
   * English strings a catalog is allowed to render more than one way, because
   * its grammar forces the difference — a counter form, a plural stem, a verb
   * where English reuses the noun. Everything else must read the same way
   * everywhere in one catalog.
   */
  const wordingExceptionsRead = readWordingExceptions(root);
  problems.push(...wordingExceptionsRead.problems);
  const { wordingExceptions } = wordingExceptionsRead;
  const { tags, problems: languageProblems } = supportedLanguages(root);
  problems.push(...languageProblems);
  // A tag list this check could not read leaves the set null: every present tag
  // is then audited, as it was before the list existed.
  const supported = tags === null ? null : new Set(tags);

  const catalogs = catalogsOf(root);
  // An audit of the repository root itself must have every declared source
  // tree; a fixture tree holds only the parts a test gives it. Read once,
  // because every catalog's scan needs the same answer.
  const requiresSourceRoots = resolve(root) === resolve(ROOT);
  // The parsed English map and locale values of each catalog a scan read, keyed
  // by catalog name. A rule that compares the two catalogs reads them here; a
  // catalog whose English parse failed stays out, so the rule cannot compare
  // against a catalog the audit already reported as unreadable.
  const parsedCatalogs = new Map();
  // The tag set of each catalog folder serves both the registry checks and the
  // per-catalog checks, so one refused listing reports one line here and skips
  // the rules that need the set.
  const presentByCatalog = new Map();
  for (const catalog of catalogs) {
    try {
      presentByCatalog.set(catalog, new Set(catalogTags(catalog.dir)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${catalog.name}: cannot audit the catalog folder: ${message}`);
      presentByCatalog.set(catalog, null);
    }
  }
  for (const catalog of catalogs) {
    const present = presentByCatalog.get(catalog);
    if (catalog.localeRegistry && present !== null) {
      problems.push(...checkPushLocaleRegistry({ root, catalog, present, supported }));
    }
  }

  for (const catalog of catalogs) {
    const catalogName = catalog.name;
    const present = presentByCatalog.get(catalog);
    if (present === null) {
      // The folder line above already names why this catalog cannot be read.
      continue;
    }

    // A tag list this could not read would report every catalog file as an
    // unsupported language and bury the one line that names the real cause.
    if (tags !== null) {
      problems.push(...checkCatalogMembership({ catalogName, tags, present, dir: catalog.dir }));
    }

    const parsedEnglish = parseCatalog(join(catalog.dir, 'en.json'), `${catalogName}/en`);
    problems.push(...parsedEnglish.problems);
    const english = parsedEnglish.catalog;
    if (english === null) {
      continue;
    }
    // One scan of this catalog's own source roots serves the usage check, and
    // its destructive-confirm rule for the mobile catalog.
    const source = scanSource(catalog, root, requiresSourceRoots);
    problems.push(...source.problems);
    // The base each catalog's consumers append their own part to: a plural stem
    // in the app, a `.title`/`.body` part in the push runtime.
    const baseKeyOf = catalog.baseKeyOf;
    const mustTranslateKeys = MUST_TRANSLATE_KEYS.get(catalogName) ?? new Set();
    const englishFamilies = pluralFamilyBases(english);
    // English copy that interpolates {{count}} but whose words inflect none or
    // only by count, so English ships a flat key (or a family). A language whose
    // nouns do change with the count may declare a family for that base; see the
    // locale loop below.
    const englishCountedBases = countPlaceholderBases(english);
    const englishValues = new Set(english.values());
    // Keys whose English text is identical. Short strings only: a long sentence
    // repeated verbatim is rare, and a 60-character cap keeps the groups to the
    // labels and messages where one wording actually matters.
    const wordingGroups = new Map();
    for (const [key, value] of english) {
      if (value.length < 2 || value.length > 60) {
        continue;
      }
      const folded = wording(value);
      if (!wordingGroups.has(folded)) {
        wordingGroups.set(folded, []);
      }
      wordingGroups.get(folded).push(key);
    }
    const sharedWordings = [...wordingGroups].filter(([, keys]) => keys.length > 1);
    const destructiveChecks = destructiveConfirmKeys(source, english);
    // The English reference one catalog's rules read, built once and never
    // mutated, so a new rule-specific fact is one field here rather than a
    // parameter on every rule layer.
    const englishFacts = Object.freeze({
      english,
      families: englishFamilies,
      countedBases: englishCountedBases,
      values: englishValues,
      mustTranslateKeys,
      destructiveChecks,
    });

    problems.push(...checkEnglishCatalog({ catalogName, english, englishValues }));

    const locales = checkCatalogLocales({
      catalog,
      selectableCategories: catalog.selectableCategoriesOf,
      present,
      supported,
      englishFacts,
      sharedWordings,
      wordingExceptions,
    });
    problems.push(...locales.problems);
    const { localeValues } = locales;
    parsedCatalogs.set(catalogName, { english, localeValues });

    for (const rule of catalog.englishCopyRules) {
      problems.push(...rule({ catalogName, english, localeValues }));
    }

    problems.push(
      ...checkSourceUsage({ catalogName, english, source, baseKeyOf, englishFamilies })
    );
  }

  // Placed after the per-catalog loop, because the rule compares the two
  // catalogs and needs both of their parsed maps.
  problems.push(...checkSeverityWordingParity(parsedCatalogs));

  return { problems, languages: tags === null ? null : tags.length };
}

/** The whole audit, reported the way CI reads it. */
function run() {
  const { problems: found, languages } = checkCatalogs();
  if (found.length > 0) {
    const parsedLimit = Number(process.env.I18N_CHECK_LIMIT ?? '50');
    const limit = Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 50;
    const shown = found.slice(0, limit);
    for (const problem of shown) {
      console.error(problem);
    }
    if (found.length > shown.length) {
      console.error(`... and ${found.length - shown.length} more`);
    }
    console.error(`\ncheck-catalogs: ${found.length} problem(s)`);
    // The exit status is kept while Node drains the pending writes: a forced
    // exit can lose the tail of a report piped to a slow reader.
    process.exitCode = 1;
    return;
  }

  console.log(`check-catalogs: ${languages} languages, every catalog matches en.json`);
}

runIfMain(run, import.meta.url);
