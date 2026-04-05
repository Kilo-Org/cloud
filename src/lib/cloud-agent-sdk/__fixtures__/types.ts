import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';

type ExpectedPart = {
  id: string;
  type: string;
  [key: string]: unknown;
};

type Fixture = {
  name: string;
  description: string;
  events: CloudAgentEvent[];
  expected: {
    messageIds: string[];
    parts: Record<string, ExpectedPart[]>;
  };
};

export type { Fixture, ExpectedPart };
