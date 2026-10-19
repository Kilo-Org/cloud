import { NextResponse } from 'next/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { WebhookIssuePayloadSchema } from '@/lib/auto-triage/core/schemas';
import { IssueWebhookProcessor } from '@/lib/auto-triage/application/webhook/issue-webhook-processor';
import { ConfigValidator } from '@/lib/auto-triage/application/webhook/config-validator';

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

export async function handleIssueAutoTriage(
  payload: IssuePayload,
  integration: PlatformIntegration
) {
  const configValidator = new ConfigValidator();
  const processor = new IssueWebhookProcessor(configValidator);
  return processor.process(payload, integration);
}

export async function handleIssue(payload: unknown, integration: PlatformIntegration) {
  const action = (payload as { action?: string }).action;

  if (action === 'labeled' || action === 'unlabeled') {
    return NextResponse.json({ message: 'Event received' }, { status: 200 });
  }

  const parseResult = WebhookIssuePayloadSchema.safeParse(payload);

  if (!parseResult.success) {
    logExceptInTest('Invalid issue webhook payload:', parseResult.error);
    return NextResponse.json(
      { error: 'Invalid webhook payload', details: parseResult.error.issues },
      { status: 400 }
    );
  }

  const validatedPayload = parseResult.data;

  switch (validatedPayload.action) {
    case 'opened':
    case 'reopened':
      return handleIssueAutoTriage(validatedPayload, integration);
    case 'edited':
      // TODO: Add support for edited events
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
    default:
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
  }
}
