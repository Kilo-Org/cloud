import { type TFunction } from 'i18next';

/**
 * The catalog key of every audit action this screen names. An action is the
 * server's own wire identifier (`organization.settings.change`), so the row
 * translates it instead of showing it; an action this map does not name — an
 * event a server newer than this build writes — falls back to the generic
 * label, because a bare identifier tells the reader nothing.
 *
 * The property names are the raw action strings, so they keep their dots and
 * stay quoted.
 */
const AUDIT_ACTION_KEYS = {
  'organization.user.login': 'organization.auditLog.action.userLogin',
  'organization.user.logout': 'organization.auditLog.action.userLogout',
  'organization.user.accept_invite': 'organization.auditLog.action.userAcceptInvite',
  'organization.user.send_invite': 'organization.auditLog.action.userSendInvite',
  'organization.user.revoke_invite': 'organization.auditLog.action.userRevokeInvite',
  'organization.settings.change': 'organization.auditLog.action.settingsChange',
  'organization.settings.auto_change': 'organization.auditLog.action.settingsAutoChange',
  'organization.purchase_credits': 'organization.auditLog.action.purchaseCredits',
  'organization.promo_credit_granted': 'organization.auditLog.action.promoCreditGranted',
  'organization.member.remove': 'organization.auditLog.action.memberRemove',
  'organization.member.change_role': 'organization.auditLog.action.memberChangeRole',
  'organization.member.admin_add': 'organization.auditLog.action.memberAdminAdd',
  'organization.member.auto_join': 'organization.auditLog.action.memberAutoJoin',
  'organization.sso.auto_provision': 'organization.auditLog.action.ssoAutoProvision',
  'organization.sso.set_domain': 'organization.auditLog.action.ssoSetDomain',
  'organization.sso.remove_domain': 'organization.auditLog.action.ssoRemoveDomain',
  'organization.domain_claim.create': 'organization.auditLog.action.domainClaimCreate',
  'organization.domain_claim.verify': 'organization.auditLog.action.domainClaimVerify',
  'organization.domain_claim.lose_verification':
    'organization.auditLog.action.domainClaimLoseVerification',
  'organization.domain_claim.remove': 'organization.auditLog.action.domainClaimRemove',
  'organization.domain_claim.cleanup_started':
    'organization.auditLog.action.domainClaimCleanupStarted',
  'organization.domain_claim.cleanup_completed':
    'organization.auditLog.action.domainClaimCleanupCompleted',
  'organization.domain_claim.cleanup_failed':
    'organization.auditLog.action.domainClaimCleanupFailed',
  'organization.mode.create': 'organization.auditLog.action.modeCreate',
  'organization.mode.update': 'organization.auditLog.action.modeUpdate',
  'organization.mode.delete': 'organization.auditLog.action.modeDelete',
  'organization.webhook_trigger.update': 'organization.auditLog.action.webhookTriggerUpdate',
  'organization.group.create': 'organization.auditLog.action.groupCreate',
  'organization.group.update': 'organization.auditLog.action.groupUpdate',
  'organization.group.delete': 'organization.auditLog.action.groupDelete',
  'organization.group.members.set': 'organization.auditLog.action.groupMembersSet',
  'organization.group.member_groups.set': 'organization.auditLog.action.groupMemberGroupsSet',
  'organization.group.policy.set': 'organization.auditLog.action.groupPolicySet',
  'organization.group.policy.remove': 'organization.auditLog.action.groupPolicyRemove',
  'organization.group.default_policy.set': 'organization.auditLog.action.groupDefaultPolicySet',
  'organization.group.default_policy.remove':
    'organization.auditLog.action.groupDefaultPolicyRemove',
  'organization.group.policy_type.enable': 'organization.auditLog.action.groupPolicyTypeEnable',
  'organization.group.policy_type.disable': 'organization.auditLog.action.groupPolicyTypeDisable',
  'organization.created': 'organization.auditLog.action.organizationCreated',
  'organization.token.generate': 'organization.auditLog.action.tokenGenerate',
  'organization.funds.distribute_to_children':
    'organization.auditLog.action.fundsDistributeToChildren',
  'organization.guardrail.add': 'organization.auditLog.action.guardrailAdd',
  'organization.guardrail.update': 'organization.auditLog.action.guardrailUpdate',
  'organization.guardrail.remove': 'organization.auditLog.action.guardrailRemove',
} satisfies Record<string, string>;

type AuditAction = keyof typeof AUDIT_ACTION_KEYS;

function isAuditAction(action: string): action is AuditAction {
  return Object.hasOwn(AUDIT_ACTION_KEYS, action);
}

/** The row's event name in the reader's language, or the generic label for an action it doesn't know. */
export function auditActionLabel(t: TFunction, action: string): string {
  const key = isAuditAction(action)
    ? AUDIT_ACTION_KEYS[action]
    : 'organization.auditLog.action.unknown';
  return t(key);
}
