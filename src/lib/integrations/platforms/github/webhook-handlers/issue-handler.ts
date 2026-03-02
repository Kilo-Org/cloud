import { NextResponse } from 'next/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { logExceptInTest } from '@/lib/utils.server';
import { WebhookIssuePayloadSchema } from '@/lib/auto-triage/core/schemas';
import { IssueLabeledPayloadSchema } from '@/lib/auto-fix/core/schemas';
import { IssueWebhookProcessor } from '@/lib/auto-triage/application/webhook/issue-webhook-processor';
import { ConfigValidator } from '@/lib/auto-triage/application/webhook/config-validator';
import { LabelWebhookProcessor } from '@/lib/auto-fix/application/webhook/label-webhook-processor';

/**
 * GitHub Issue Event Handler for Auto Triage
 * Handles: opened, reopened
 *
 * This handler processes GitHub issue events and creates triage tickets
 * for automatic analysis, duplicate detection, and classification.
 */

/**
 * Issue payload type inferred from schema
 */
type IssuePayload = {
  action: 'opened' | 'reopened' | 'edited';
  issue: {
    number: number;
    html_url: string;
    title: string;
    body: string | null;
    user: {
      login: string;
      type?: string;
    };
    labels?: Array<string | { name: string }>;
  };
  repository: {
    id: number;
    full_name: string;
    private: boolean;
  };
  sender: {
    login: string;
    type?: string;
  };
};

/**
 * Handles issue events that trigger auto triage
 * (opened, reopened)
 */
export async function handleIssueAutoTriage(
  payload: IssuePayload,
  integration: PlatformIntegration
) {
  const configValidator = new ConfigValidator();
  const processor = new IssueWebhookProcessor(configValidator);
  return processor.process(payload, integration);
}

/**
 * Handles issue labeled events for Auto Fix
 */
export async function handleIssueLabeled(payload: unknown, integration: PlatformIntegration) {
  // Validate payload structure for labeled event
  const parseResult = IssueLabeledPayloadSchema.safeParse(payload);

  if (!parseResult.success) {
    logExceptInTest('Invalid issue labeled webhook payload:', parseResult.error);
    return NextResponse.json(
      { error: 'Invalid webhook payload', details: parseResult.error.issues },
      { status: 400 }
    );
  }

  const processor = new LabelWebhookProcessor();
  return processor.process(parseResult.data, integration);
}

/**
 * Main router for issue events
 * Routes to appropriate handler based on action
 */
export async function handleIssue(payload: unknown, integration: PlatformIntegration) {
  // Check action first to route to correct validator
  const action = (payload as { action?: string }).action;

  // Handle labeled action separately (different schema)
  if (action === 'labeled') {
    return handleIssueLabeled(payload, integration);
  }

  // Ignore unlabeled events - we only care about when labels are added
  if (action === 'unlabeled') {
    return NextResponse.json({ message: 'Event received' }, { status: 200 });
  }

  // Validate payload structure for other actions
  const parseResult = WebhookIssuePayloadSchema.safeParse(payload);

  if (!parseResult.success) {
    logExceptInTest('Invalid issue webhook payload:', parseResult.error);
    return NextResponse.json(
      { error: 'Invalid webhook payload', details: parseResult.error.issues },
      { status: 400 }
    );
  }

  const validatedPayload = parseResult.data;

  // Handle opened and reopened actions
  switch (validatedPayload.action) {
    case 'opened':
    case 'reopened':
      return handleIssueAutoTriage(validatedPayload, integration);
    case 'edited':
      // Ignore edited events for now
      // TODO: Add support for edited events
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
    default:
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
  }
}
