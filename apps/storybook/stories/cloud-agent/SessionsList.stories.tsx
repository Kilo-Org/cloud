import type { Meta, StoryObj } from '@storybook/nextjs';
import { SessionsList, type SessionsListItem } from '@/components/cloud-agent/SessionsList';

const meta: Meta<typeof SessionsList> = {
  title: 'Cloud Agent/SessionsList',
  component: SessionsList,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

const mockSessions: SessionsListItem[] = [
  {
    sessionId: 'session-123-active',
    repository: 'user/my-nextjs-app',
    prompt: 'Implement user authentication with NextAuth',
    mode: 'code',
    createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 minutes ago
    createdOnPlatform: 'cloud-agent', // Cloud badge
  },
  {
    sessionId: 'session-456-completed',
    repository: 'user/my-react-app',
    prompt: 'Add dark mode support to the application',
    mode: 'code',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
    createdOnPlatform: 'cli', // CLI badge
  },
  {
    sessionId: 'session-789-error',
    repository: 'user/my-api',
    prompt: 'Refactor the authentication middleware',
    mode: 'code',
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 minutes ago
    createdOnPlatform: 'vscode', // Extension badge (any value other than cloud-agent or cli)
  },
  {
    sessionId: 'session-abc-completed',
    repository: 'organization/enterprise-app',
    prompt: 'Update all dependencies to latest versions',
    mode: 'code',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
    createdOnPlatform: 'unknown', // Extension badge (unknown defaults to extension)
  },
  {
    sessionId: 'session-def-active',
    repository: 'organization/managed-project',
    prompt: 'Run automated code review and apply fixes',
    mode: 'code',
    createdAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(), // 15 minutes ago
    createdOnPlatform: 'agent-manager', // Agent Manager badge
  },
];

export const Default: Story = {
  args: {
    sessions: mockSessions,
  },
};

export const Empty: Story = {
  args: {
    sessions: [],
  },
};

export const SingleSession: Story = {
  args: {
    sessions: [mockSessions[0]],
  },
};

export const WithOrganization: Story = {
  args: {
    sessions: mockSessions,
    organizationId: 'org-123',
  },
};

/**
 * On mobile viewports (< 640px), the platform badge moves to a new line below the title.
 * Use Storybook's viewport addon to test responsive behavior.
 */
export const LongTitles: Story = {
  args: {
    sessions: [
      {
        sessionId: 'session-long-1',
        repository: 'user/complex-enterprise-application-with-microservices',
        prompt:
          'Implement comprehensive user authentication system with OAuth2, SAML SSO, multi-factor authentication, and role-based access control',
        mode: 'code',
        createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
        createdOnPlatform: 'cloud-agent',
      },
      {
        sessionId: 'session-long-2',
        repository: 'organization/very-long-repository-name-for-testing-truncation',
        prompt:
          'Refactor the entire authentication middleware to support multiple identity providers and implement comprehensive logging',
        mode: 'architect',
        createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        createdOnPlatform: 'agent-manager',
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Sessions with long titles. On mobile viewports (< 640px), the platform badge moves to its own line below the title for better readability.',
      },
    },
  },
};
