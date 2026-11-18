import { type TFunction } from 'i18next';

import {
  type OrganizationAuditLogDetails,
  OrganizationAuditLogDetailsSchema,
} from '@kilocode/db/schema-types';

import {
  BEHAVIOR_KEYS,
  BITBUCKET_WORKSPACE_KEYS,
  BYOK_VERB_KEYS,
  DATA_COLLECTION_KEYS,
  describeDetectors,
  formatDollarsFromCents,
  GITHUB_VERB_KEYS,
  MCP_TYPE_KEYS,
  PLATFORM_KEYS,
  POLICY_TYPE_KEYS,
  REGION_KEYS,
  ROLE_KEYS,
  stateLabel,
} from '@/components/organization/audit-log-detail-keys';

// The audit detail builder: the row's structured `details` become one sentence
// in the reader's language. Every t() call names one complete literal key so
// the catalog checker can verify the catalogs. Shared key maps and the
// guardrails detector fragments live in ./audit-log-detail-keys.

/**
 * The row's detail sentence from the entry's structured `details`, in the
 * reader's language; null when the row has no details, an unknown `kind` (a
 * server newer than this app), or a payload that fails the shared schema — the
 * row then shows the event name, actor, and time only, never the raw English
 * server message.
 */
export function auditLogDetailFor(t: TFunction, details: unknown): string | null {
  const parsed = OrganizationAuditLogDetailsSchema.safeParse(details);
  if (!parsed.success) {
    return null;
  }
  const d: OrganizationAuditLogDetails = parsed.data;

  switch (d.kind) {
    case 'guardrails_input': {
      const appliesTo = d.group
        ? t('organization.auditLog.detail.appliesGroup', { name: d.group.name })
        : t('organization.auditLog.detail.appliesAllMembers');
      return t('organization.auditLog.detail.guardrailsInput', {
        state: stateLabel(t, d.enabled),
        appliesTo,
        detectors: describeDetectors(t, d.detectors),
        outputState: stateLabel(t, d.outputEnabled),
        outputDetectors: describeDetectors(t, d.outputDetectors),
      });
    }
    case 'guardrails_scope_all': {
      return t('organization.auditLog.detail.guardrailsScopeAll', { name: d.group.name });
    }
    case 'group_created': {
      return t('organization.auditLog.detail.groupCreated', { name: d.name });
    }
    case 'group_updated': {
      return t('organization.auditLog.detail.groupUpdated', { name: d.name });
    }
    case 'group_deleted': {
      return t('organization.auditLog.detail.groupDeleted', { name: d.name });
    }
    case 'group_members_set': {
      return t('organization.auditLog.detail.groupMembersSet', {
        name: d.name,
        count: d.membersCount,
      });
    }
    case 'group_member_groups_set': {
      return t('organization.auditLog.detail.groupMemberGroupsSet', { count: d.groupsCount });
    }
    case 'group_policy_set': {
      return t('organization.auditLog.detail.groupPolicySet', {
        name: d.group.name,
        policy: t(POLICY_TYPE_KEYS[d.policyType]),
      });
    }
    case 'group_policy_removed': {
      return t('organization.auditLog.detail.groupPolicyRemoved', {
        name: d.group.name,
        policy: t(POLICY_TYPE_KEYS[d.policyType]),
      });
    }
    case 'group_default_policy_set': {
      return t('organization.auditLog.detail.groupDefaultPolicySet', {
        policy: t(POLICY_TYPE_KEYS[d.policyType]),
      });
    }
    case 'group_default_policy_removed': {
      return t('organization.auditLog.detail.groupDefaultPolicyRemoved', {
        policy: t(POLICY_TYPE_KEYS[d.policyType]),
      });
    }
    case 'member_invited': {
      return t('organization.auditLog.detail.memberInvited', {
        email: d.email,
        role: t(ROLE_KEYS[d.role]),
      });
    }
    case 'member_role_changed': {
      return t('organization.auditLog.detail.memberRoleChanged', {
        email: d.email,
        fromRole: t(ROLE_KEYS[d.fromRole]),
        toRole: t(ROLE_KEYS[d.toRole]),
      });
    }
    case 'member_removed': {
      return t('organization.auditLog.detail.memberRemoved', { email: d.email });
    }
    case 'member_added': {
      return t('organization.auditLog.detail.memberAdded', {
        email: d.email,
        role: t(ROLE_KEYS[d.role]),
      });
    }
    case 'parent_member_added': {
      return t('organization.auditLog.detail.parentMemberAdded', {
        email: d.email,
        name: d.parentOrganizationName,
      });
    }
    case 'parent_member_removed': {
      return t('organization.auditLog.detail.parentMemberRemoved', {
        email: d.email,
        name: d.parentOrganizationName,
      });
    }
    case 'accept_invite': {
      return t('organization.auditLog.detail.acceptInvite', { email: d.email });
    }
    case 'revoke_invite': {
      return t('organization.auditLog.detail.revokeInvite', { email: d.email });
    }
    case 'funds_distributed': {
      return t('organization.auditLog.detail.fundsDistributed', {
        amount: formatDollarsFromCents(Math.round(d.amountMicrodollars / 10_000)),
        count: d.childCount,
      });
    }
    case 'funds_received': {
      return t('organization.auditLog.detail.fundsReceived', {
        amount: formatDollarsFromCents(Math.round(d.amountMicrodollars / 10_000)),
        name: d.parentOrganizationName,
      });
    }
    case 'credits_purchased': {
      return t('organization.auditLog.detail.creditsPurchased', {
        amount: formatDollarsFromCents(d.amountCents),
        method: d.methodType,
      });
    }
    case 'promo_credit_granted': {
      return t('organization.auditLog.detail.promoCreditGranted', {
        amount: formatDollarsFromCents(d.amountCents),
        description: d.description,
      });
    }
    case 'sso_domain_set': {
      return t('organization.auditLog.detail.ssoDomainSet', { domain: d.domain });
    }
    case 'sso_domain_removed': {
      return t('organization.auditLog.detail.ssoDomainRemoved', { domain: d.domain });
    }
    case 'byok_key_changed': {
      return t(BYOK_VERB_KEYS[d.verb], { provider: d.providerId });
    }
    case 'byok_priorities_reordered': {
      return t('organization.auditLog.detail.byokReordered');
    }
    case 'integration_model_changed': {
      return t('organization.auditLog.detail.integrationModelChanged', {
        platform: t(PLATFORM_KEYS[d.platform]),
        model: d.modelSlug,
      });
    }
    case 'integration_disconnected': {
      return t('organization.auditLog.detail.integrationDisconnected', {
        platform: t(PLATFORM_KEYS[d.platform]),
      });
    }
    case 'github_installation_changed': {
      return t(GITHUB_VERB_KEYS[d.verb], d.modelSlug != null ? { model: d.modelSlug } : {});
    }
    case 'review_config_changed': {
      const style = d.style ?? t('organization.auditLog.detail.reviewStyleUnknown');
      return d.webhooksCreated != null
        ? t('organization.auditLog.detail.reviewConfigChangedWebhooks', {
            platform: d.platform,
            style,
            created: d.webhooksCreated,
            deleted: d.webhooksDeleted ?? 0,
          })
        : t('organization.auditLog.detail.reviewConfigChanged', { platform: d.platform, style });
    }
    case 'review_agent_toggled': {
      return t(
        d.enabled
          ? 'organization.auditLog.detail.reviewAgentEnabled'
          : 'organization.auditLog.detail.reviewAgentDisabled',
        { platform: d.platform }
      );
    }
    case 'gitlab_webhook_secret_rotated': {
      return d.webhooksUpdated != null
        ? t('organization.auditLog.detail.gitlabSecretRotatedSync', {
            updated: d.webhooksUpdated,
            errors: d.errorsCount ?? 0,
          })
        : t('organization.auditLog.detail.gitlabSecretRotated');
    }
    case 'bitbucket_review_requested': {
      return t('organization.auditLog.detail.bitbucketReviewRequested', { url: d.pullRequestUrl });
    }
    case 'token_generated': {
      return t('organization.auditLog.detail.tokenGenerated', {
        name: d.organizationName,
        kind:
          d.tokenKind === 'resource'
            ? t('organization.auditLog.detail.tokenKindResource')
            : t('organization.auditLog.detail.tokenKindUser'),
      });
    }
    case 'webhook_trigger_updated': {
      return t('organization.auditLog.detail.webhookTriggerUpdated', { id: d.triggerId });
    }
    case 'gateway_settings_changed': {
      if (!d.changed) {
        return t('organization.auditLog.detail.noChanges');
      }
      const changes: string[] = [];
      if (d.openRouterDisabled != null) {
        changes.push(
          t(
            d.openRouterDisabled
              ? 'organization.auditLog.detail.openRouterOff'
              : 'organization.auditLog.detail.openRouterOn'
          )
        );
      }
      if (d.region !== undefined) {
        changes.push(
          t('organization.auditLog.detail.region', {
            region:
              d.region === null
                ? t('organizationModelAccess.region.global')
                : t(REGION_KEYS[d.region]),
          })
        );
      }
      return t('organization.auditLog.detail.gatewaySettingsChanged', {
        changes: changes.join('; '),
      });
    }
    case 'access_lists_changed': {
      const parts = [
        d.allowedModels?.length
          ? t('organization.auditLog.detail.allowedModels', { list: d.allowedModels.join(', ') })
          : null,
        d.deniedModels?.length
          ? t('organization.auditLog.detail.deniedModels', { list: d.deniedModels.join(', ') })
          : null,
        d.allowedProviders?.length
          ? t('organization.auditLog.detail.allowedProviders', {
              list: d.allowedProviders.join(', '),
            })
          : null,
        d.disallowedProviders?.length
          ? t('organization.auditLog.detail.disallowedProviders', {
              list: d.disallowedProviders.join(', '),
            })
          : null,
      ].filter(Boolean);
      return parts.length > 0
        ? parts.join('. ')
        : t('organization.auditLog.detail.accessListsOnly');
    }
    case 'default_model_changed': {
      if (d.verb === 'set') {
        return t('organization.auditLog.detail.defaultModelSet', { model: d.newModel ?? '' });
      }
      if (d.verb === 'changed') {
        return t('organization.auditLog.detail.defaultModelChanged', {
          from: d.oldModel ?? '',
          to: d.newModel ?? '',
        });
      }
      if (d.verb === 'removed') {
        return t('organization.auditLog.detail.defaultModelRemoved', { model: d.oldModel ?? '' });
      }
      return t('organization.auditLog.detail.defaultModelNoChange');
    }
    case 'auto_route_set': {
      return d.previousRoute
        ? t('organization.auditLog.detail.autoRouteUpdated', {
            mode: d.modeSlug,
            from: d.previousRoute,
            to: d.newRoute,
          })
        : t('organization.auditLog.detail.autoRouteSet', { mode: d.modeSlug, to: d.newRoute });
    }
    case 'auto_route_cleared': {
      return t('organization.auditLog.detail.autoRouteCleared', {
        mode: d.modeSlug,
        from: d.previousRoute,
      });
    }
    case 'default_behavior_changed': {
      if (d.behavior === 'specific_model') {
        return t('organization.auditLog.detail.defaultBehaviorSpecificModel', {
          model: d.model ?? '',
        });
      }
      return t(BEHAVIOR_KEYS[d.behavior]);
    }
    case 'data_collection_changed': {
      return t(DATA_COLLECTION_KEYS[d.value]);
    }
    case 'projects_ui_changed': {
      return t(
        d.enabled
          ? 'organization.auditLog.detail.projectsUiOn'
          : 'organization.auditLog.detail.projectsUiOff'
      );
    }
    case 'minimum_balance_alert_changed': {
      if (!d.enabled) {
        return t('organization.auditLog.detail.minimumBalanceAlertOff');
      }
      return t('organization.auditLog.detail.minimumBalanceAlertOn', {
        threshold: formatDollarsFromCents(d.thresholdCents ?? 0),
        emails: d.alertEmails?.join(', ') ?? '',
      });
    }
    case 'recommendations_digest_changed': {
      return t(
        d.enabled
          ? 'organization.auditLog.detail.recommendationsDigestOn'
          : 'organization.auditLog.detail.recommendationsDigestOff'
      );
    }
    case 'browser_control_changed': {
      return t('organization.auditLog.detail.browserControl', {
        mode: d.mode,
        origins: d.origins?.length
          ? d.origins.join(', ')
          : t('organization.auditLog.detail.originsNone'),
      });
    }
    case 'mcp_guardrail_added': {
      return t('organization.auditLog.detail.mcpGuardrailAdded', {
        name: d.name,
        type: t(MCP_TYPE_KEYS[d.type]),
      });
    }
    case 'mcp_guardrail_updated': {
      return t('organization.auditLog.detail.mcpGuardrailUpdated', {
        name: d.name,
        type: t(MCP_TYPE_KEYS[d.type]),
      });
    }
    case 'mcp_guardrail_status_changed': {
      return t(
        d.enabled
          ? 'organization.auditLog.detail.mcpGuardrailEnabled'
          : 'organization.auditLog.detail.mcpGuardrailDisabled',
        {
          name: d.name,
          type: t(MCP_TYPE_KEYS[d.type]),
        }
      );
    }
    case 'mcp_guardrail_removed': {
      return t('organization.auditLog.detail.mcpGuardrailRemoved', {
        name: d.name,
        type: t(MCP_TYPE_KEYS[d.type]),
      });
    }
    case 'guardrails_enforcement_changed': {
      if (d.target === 'mcp') {
        // The enforcement string stays out of the localized sentence: each mode
        // has its own key, so the reader's language carries the mode's wording.
        const ENFORCEMENT_KEYS = {
          off: 'organization.auditLog.detail.mcpEnforcementOff',
          shadow: 'organization.auditLog.detail.mcpEnforcementShadow',
          enforce: 'organization.auditLog.detail.mcpEnforcementEnforce',
        } as const;
        if (d.enforcement != null && Object.hasOwn(ENFORCEMENT_KEYS, d.enforcement)) {
          return t(ENFORCEMENT_KEYS[d.enforcement as keyof typeof ENFORCEMENT_KEYS]);
        }
        return t('organization.auditLog.detail.mcpEnforcement', {
          enforcement: d.enforcement ?? '',
        });
      }
      const enabled =
        d.enabled == null
          ? ''
          : t(
              d.enabled
                ? 'organization.auditLog.detail.skillOn'
                : 'organization.auditLog.detail.skillOff'
            );
      const scan =
        d.scanBeforeUse == null
          ? ''
          : t(
              d.scanBeforeUse
                ? 'organization.auditLog.detail.scanOn'
                : 'organization.auditLog.detail.scanOff'
            );
      return t('organization.auditLog.detail.skillEnforcement', { enabled, scan });
    }
    case 'bitbucket_workspace_changed': {
      return t(BITBUCKET_WORKSPACE_KEYS[d.verb], { workspace: d.workspaceSlug });
    }
    // mode_created / mode_deleted / organization_created / organization_renamed /
    // sso_logged_in carry facts the row's event name and actor line already
    // state, or (org names) copy the screen's own title, so no detail line.
    case 'mode_created':
    case 'mode_deleted':
    case 'organization_created':
    case 'organization_renamed':
    case 'sso_logged_in': {
      return null;
    }
    // An unknown `kind` from a server newer than this build lands here too.
    default: {
      return null;
    }
  }
}
