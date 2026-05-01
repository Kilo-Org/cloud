jest.mock('@/lib/bot/request-logging', () => ({
  createBotRequest: jest.fn(),
  updateBotRequest: jest.fn(),
}));

jest.mock('@/lib/bot/run', () => ({
  processMessage: jest.fn(),
}));

jest.mock(
  'chat',
  () => ({
    Message: class Message {
      readonly attachments: unknown[];
      readonly author: unknown;
      readonly formatted: unknown;
      readonly id: string;
      readonly metadata: unknown;
      readonly raw: unknown;
      readonly text: string;
      readonly threadId: string;

      constructor(data: {
        attachments: unknown[];
        author: unknown;
        formatted: unknown;
        id: string;
        metadata: unknown;
        raw: unknown;
        text: string;
        threadId: string;
      }) {
        this.attachments = data.attachments;
        this.author = data.author;
        this.formatted = data.formatted;
        this.id = data.id;
        this.metadata = data.metadata;
        this.raw = data.raw;
        this.text = data.text;
        this.threadId = data.threadId;
      }
    },
  }),
  { virtual: true }
);

import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import { processMessage } from '@/lib/bot/run';
import { processAuthenticatedBotMessage } from '@/lib/bot/message-processing';
import type { PlatformIntegration, User } from '@kilocode/db';
import { Message } from 'chat';
import type { Thread } from 'chat';

const mockCreateBotRequest = jest.mocked(createBotRequest);
const mockUpdateBotRequest = jest.mocked(updateBotRequest);
const mockProcessMessage = jest.mocked(processMessage);

function createUser(): User {
  return {
    id: 'user_1',
    google_user_email: 'user@example.com',
    google_user_name: 'Test User',
    google_user_image_url: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    hosted_domain: null,
    microdollars_used: 0,
    kilo_pass_threshold: null,
    stripe_customer_id: 'cus_123',
    is_admin: false,
    total_microdollars_acquired: 0,
    next_credit_expiration_at: null,
    has_validation_stytch: null,
    has_validation_novel_card_with_hold: false,
    blocked_reason: null,
    blocked_at: null,
    blocked_by_kilo_user_id: null,
    api_token_pepper: null,
    web_session_pepper: null,
    auto_top_up_enabled: false,
    is_bot: false,
    kiloclaw_early_access: false,
    default_model: null,
    cohorts: {},
    completed_welcome_form: false,
    linkedin_url: null,
    github_url: null,
    discord_server_membership_verified_at: null,
    openrouter_upstream_safety_identifier: null,
    vercel_downstream_safety_identifier: null,
    customer_source: null,
    signup_ip: null,
    account_deletion_requested_at: null,
    normalized_email: null,
    email_domain: null,
  };
}

function createPlatformIntegration(): PlatformIntegration {
  return {
    id: 'pi_slack',
    owned_by_user_id: 'user_1',
    owned_by_organization_id: null,
    created_by_user_id: null,
    platform: 'slack',
    integration_type: 'oauth',
    platform_installation_id: 'T123',
    platform_account_id: 'T123',
    platform_account_login: 'Test Workspace',
    permissions: null,
    integration_status: 'active',
    scopes: null,
    repository_access: null,
    repositories: null,
    repositories_synced_at: null,
    metadata: {},
    kilo_requester_user_id: null,
    platform_requester_account_id: null,
    suspended_at: null,
    suspended_by: null,
    github_app_type: 'standard',
    installed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function createMessage(): Message {
  return new Message({
    id: '1710000000.000000',
    threadId: 'slack:T123:C456:1710000000.000000',
    text: 'Please fix this bug',
    formatted: { type: 'root', children: [] },
    raw: { type: 'message', team: 'T123', ts: '1710000000.000000' },
    author: {
      fullName: 'Test User',
      isBot: false,
      isMe: false,
      userId: 'U123',
      userName: 'test-user',
    },
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z'), edited: false },
    attachments: [],
  });
}

describe('processAuthenticatedBotMessage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockCreateBotRequest.mockResolvedValue('bot_request_1');
    mockProcessMessage.mockResolvedValue(undefined);
  });

  it('creates request logging and processes the message', async () => {
    const thread = {
      id: 'slack:T123:C456:1710000000.000000',
      startTyping: jest.fn(),
      post: jest.fn(),
    } as unknown as Thread;
    const message = createMessage();
    const platformIntegration = createPlatformIntegration();
    const user = createUser();

    await processAuthenticatedBotMessage({ thread, message, platformIntegration, user });

    expect(mockCreateBotRequest).toHaveBeenCalledWith({
      createdBy: 'user_1',
      organizationId: null,
      platformIntegrationId: 'pi_slack',
      platform: 'slack',
      platformThreadId: 'slack:T123:C456:1710000000.000000',
      platformMessageId: '1710000000.000000',
      userMessage: 'Please fix this bug',
      modelUsed: undefined,
    });
    expect(thread.startTyping).toHaveBeenCalledWith('Thinking...');
    expect(mockProcessMessage).toHaveBeenCalledWith({
      thread,
      message,
      platformIntegration,
      user,
      botRequestId: 'bot_request_1',
    });
  });

  it('records an error and posts a fallback if processing throws', async () => {
    const thread = {
      id: 'slack:T123:C456:1710000000.000000',
      startTyping: jest.fn(),
      post: jest.fn(),
    } as unknown as Thread;
    mockProcessMessage.mockRejectedValue(new Error('model exploded'));

    await processAuthenticatedBotMessage({
      thread,
      message: createMessage(),
      platformIntegration: createPlatformIntegration(),
      user: createUser(),
    });

    expect(mockUpdateBotRequest).toHaveBeenCalledWith('bot_request_1', {
      status: 'error',
      errorMessage: 'model exploded',
    });
    expect(thread.post).toHaveBeenCalledWith({
      markdown: 'Sorry, something went wrong while processing your message.',
    });
  });
});
