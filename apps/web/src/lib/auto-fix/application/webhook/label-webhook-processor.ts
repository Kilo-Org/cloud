import type { PlatformIntegration } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { createFixTicket, findExistingFixTicket } from '../../db/fix-tickets';
import { getTriageTicketByRepoAndIssue } from '@/lib/auto-triage/db/triage-tickets';
import { tryDispatchPendingFixes } from '../../dispatch/dispatch-pending-fixes';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import type { Owner, AutoFixAgentConfig } from '../../core/schemas';
import type { IssueLabeledPayload } from '../../core/schemas';

export class LabelWebhookProcessor {
  async process(
    payload: IssueLabeledPayload,
    integration: PlatformIntegration
  ): Promise<NextResponse> {
    const { issue, repository, label } = payload;

    logExceptInTest('[LabelWebhookProcessor] Processing labeled event', {
      repoFullName: repository.full_name,
      issueNumber: issue.number,
      label: label.name,
    });

    if (label.name !== 'kilo-auto-fix') {
      logExceptInTest('[LabelWebhookProcessor] Ignoring non-auto-fix label', {
        label: label.name,
      });
      return NextResponse.json({ message: 'Label ignored' }, { status: 200 });
    }

    const owner: Owner = integration.owned_by_organization_id
      ? {
          type: 'org',
          id: integration.owned_by_organization_id,
          userId: integration.owned_by_organization_id,
        }
      : {
          type: 'user',
          id: integration.owned_by_user_id || '',
          userId: integration.owned_by_user_id || '',
        };

    const agentConfig = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

    if (!agentConfig || !agentConfig.is_enabled) {
      logExceptInTest('[LabelWebhookProcessor] Auto Fix not enabled', {
        owner,
        hasConfig: !!agentConfig,
        isEnabled: agentConfig?.is_enabled,
      });
      return NextResponse.json({ message: 'Auto Fix not enabled' }, { status: 200 });
    }

    const config = agentConfig.config as AutoFixAgentConfig;

    if (!config.enabled_for_issues) {
      logExceptInTest('[LabelWebhookProcessor] Auto Fix not enabled for issues', { owner });
      return NextResponse.json({ message: 'Auto Fix not enabled for issues' }, { status: 200 });
    }

    if (config.repository_selection_mode === 'selected') {
      if (!config.selected_repository_ids.includes(repository.id)) {
        logExceptInTest('[LabelWebhookProcessor] Repository not in selected list', {
          repoId: repository.id,
          selectedRepos: config.selected_repository_ids,
        });
        return NextResponse.json({ message: 'Repository not selected' }, { status: 200 });
      }
    }

    const issueLabels = issue.labels.map(l => (typeof l === 'string' ? l : l.name));
    const hasSkipLabel = config.skip_labels.some(skipLabel => issueLabels.includes(skipLabel));

    if (hasSkipLabel) {
      logExceptInTest('[LabelWebhookProcessor] Issue has skip label', {
        issueLabels,
        skipLabels: config.skip_labels,
      });
      return NextResponse.json({ message: 'Issue has skip label' }, { status: 200 });
    }

    if (config.required_labels && config.required_labels.length > 0) {
      const missingLabels = config.required_labels.filter(
        requiredLabel => !issueLabels.includes(requiredLabel)
      );

      if (missingLabels.length > 0) {
        logExceptInTest('[LabelWebhookProcessor] Issue missing required labels', {
          issueLabels,
          requiredLabels: config.required_labels,
          missingLabels,
        });
        return NextResponse.json({ message: 'Issue missing required labels' }, { status: 200 });
      }
    }

    const existingTicket = await findExistingFixTicket(repository.full_name, issue.number);

    if (existingTicket) {
      logExceptInTest('[LabelWebhookProcessor] Fix ticket already exists', {
        ticketId: existingTicket.id,
        status: existingTicket.status,
      });
      return NextResponse.json(
        { message: 'Fix ticket already exists', ticketId: existingTicket.id },
        { status: 200 }
      );
    }

    let triageTicket = null;
    try {
      triageTicket = await getTriageTicketByRepoAndIssue(repository.full_name, issue.number);
    } catch (error) {
      logExceptInTest('[LabelWebhookProcessor] No triage ticket found (continuing anyway)', {
        error,
      });
    }

    try {
      // Filter out 'duplicate' classification as it's not valid for fix tickets
      const classification =
        triageTicket?.classification && triageTicket.classification !== 'duplicate'
          ? triageTicket.classification
          : undefined;

      const ticketId = await createFixTicket({
        owner,
        platformIntegrationId: integration.id,
        triageTicketId: triageTicket?.id,
        repoFullName: repository.full_name,
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        issueTitle: issue.title,
        issueBody: issue.body,
        issueAuthor: issue.user.login,
        issueLabels,
        classification,
        confidence: triageTicket?.confidence ? Number(triageTicket.confidence) : undefined,
        intentSummary: triageTicket?.intent_summary || undefined,
        relatedFiles: triageTicket?.related_files || undefined,
      });

      logExceptInTest('[LabelWebhookProcessor] Created fix ticket', {
        ticketId,
        repoFullName: repository.full_name,
        issueNumber: issue.number,
      });

      let dispatchOwner: Owner;
      if (owner.type === 'org') {
        const botUserId = await getBotUserId(owner.id, 'auto-fix');
        if (!botUserId) {
          errorExceptInTest('[LabelWebhookProcessor] Bot user not found for organization', {
            organizationId: owner.id,
          });
          return NextResponse.json({ error: 'Bot user not configured' }, { status: 500 });
        }
        dispatchOwner = {
          type: 'org',
          id: owner.id,
          userId: botUserId,
        };
      } else {
        dispatchOwner = owner;
      }

      await tryDispatchPendingFixes(dispatchOwner);

      return NextResponse.json(
        { message: 'Fix ticket created and dispatched', ticketId },
        { status: 200 }
      );
    } catch (error) {
      errorExceptInTest('[LabelWebhookProcessor] Error creating fix ticket:', error);
      captureException(error, {
        tags: { source: 'label-webhook-processor' },
        extra: { repoFullName: repository.full_name, issueNumber: issue.number },
      });
      return NextResponse.json({ error: 'Failed to create fix ticket' }, { status: 500 });
    }
  }
}
