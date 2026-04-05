import type { Meta, StoryObj } from '@storybook/nextjs';
import { MessageBubble } from '@/components/cloud-agent/MessageBubble';
import type { UserMessage, AssistantMessage, SystemMessage } from '@/components/cloud-agent/types';

const meta: Meta<typeof MessageBubble> = {
  title: 'Cloud Agent/MessageBubble',
  component: MessageBubble,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

const now = new Date().toISOString();

const userMessage: UserMessage = {
  role: 'user',
  content: 'Can you help me implement user authentication in my Next.js app?',
  timestamp: now,
};

const assistantMessage: AssistantMessage = {
  role: 'assistant',
  content:
    'I can help you implement authentication. Let me analyze your codebase first and then create the necessary components and API routes.',
  timestamp: now,
};

const systemStatusMessage: SystemMessage = {
  role: 'system',
  content: 'Session initialized successfully. Repository cloned and dependencies installed.',
  timestamp: now,
};

const systemErrorMessage: SystemMessage = {
  role: 'system',
  content:
    'Error: Failed to connect to the repository. Please check your credentials and try again.',
  timestamp: now,
};

const apiRequestMessage = {
  role: 'assistant' as const,
  content: '',
  timestamp: now,
  say: 'api_req_started',
  metadata: {
    apiProtocol: 'openai',
    tokensIn: 12663,
    tokensOut: 44,
    cacheWrites: 0,
    cacheReads: 0,
    cost: 0.0481,
    inferenceProvider: 'Anthropic',
  },
};

const toolMessage = {
  role: 'system' as const,
  content: '',
  timestamp: now,
  ask: 'tool',
  metadata: {
    tool: 'readFile',
    path: 'src/lib/auth.ts',
    isOutsideWorkspace: false,
  },
  partial: false,
};

const commandMessage = {
  role: 'system' as const,
  content: '',
  timestamp: now,
  ask: 'command',
  metadata: {
    tool: 'bash',
    command: 'echo $SECRET_KEY',
  },
  partial: false,
};

export const User: Story = {
  args: {
    message: userMessage,
  },
};

export const Assistant: Story = {
  args: {
    message: assistantMessage,
  },
};

export const AssistantMessageStreaming: Story = {
  args: {
    message: {
      ...assistantMessage,
      content: 'I can help you implement authentication. Let me analyze your...',
    },
    isStreaming: true,
  },
};

export const SystemStatusMessage: Story = {
  args: {
    message: systemStatusMessage,
  },
};

export const SystemErrorMessage: Story = {
  args: {
    message: systemErrorMessage,
  },
};

export const ApiRequest: Story = {
  args: {
    message: apiRequestMessage,
  },
};

export const ToolExecution: Story = {
  args: {
    message: toolMessage,
  },
};

export const CommandExecution: Story = {
  args: {
    message: commandMessage,
  },
};
