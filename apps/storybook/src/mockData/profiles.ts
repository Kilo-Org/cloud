import type {
  ProfileSummary,
  ProfileDetails,
  ProfileVar,
  ProfileCommand,
} from '@/hooks/useCloudAgentProfiles';

/**
 * Mock data for profile components in Storybook
 */

export const mockProfileVars: ProfileVar[] = [
  {
    key: 'AWS_ACCESS_KEY_ID',
    value: '***',
    isSecret: true,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    key: 'AWS_SECRET_ACCESS_KEY',
    value: '***',
    isSecret: true,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    key: 'AWS_REGION',
    value: 'us-east-1',
    isSecret: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    key: 'NODE_ENV',
    value: 'production',
    isSecret: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    key: 'DATABASE_URL',
    value: '***',
    isSecret: true,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
];

export const mockProfileCommands: ProfileCommand[] = [
  { sequence: 0, command: 'npm install' },
  { sequence: 1, command: 'npm run build' },
];

export const mockProfiles: ProfileSummary[] = [
  {
    id: 'profile-1',
    name: 'AWS Production',
    description: 'Production environment with AWS credentials',
    isDefault: true,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
    varCount: 5,
    commandCount: 2,
  },
  {
    id: 'profile-2',
    name: 'Local Development',
    description: null,
    isDefault: false,
    createdAt: '2025-01-03T00:00:00Z',
    updatedAt: '2025-01-03T00:00:00Z',
    varCount: 3,
    commandCount: 0,
  },
  {
    id: 'profile-3',
    name: 'Staging Environment',
    description: 'Staging environment with test credentials and staging database connection',
    isDefault: false,
    createdAt: '2025-01-04T00:00:00Z',
    updatedAt: '2025-01-05T00:00:00Z',
    varCount: 8,
    commandCount: 3,
  },
  {
    id: 'profile-4',
    name: 'CI/CD Pipeline',
    description: 'Configuration for automated testing and deployment pipelines',
    isDefault: false,
    createdAt: '2025-01-06T00:00:00Z',
    updatedAt: '2025-01-06T00:00:00Z',
    varCount: 10,
    commandCount: 5,
  },
  {
    id: 'profile-5',
    name: 'Empty Profile',
    description: 'An empty profile for testing',
    isDefault: false,
    createdAt: '2025-01-07T00:00:00Z',
    updatedAt: '2025-01-07T00:00:00Z',
    varCount: 0,
    commandCount: 0,
  },
];

export const mockProfileDetails: ProfileDetails = {
  id: 'profile-1',
  name: 'AWS Production',
  description: 'Production environment with AWS credentials',
  isDefault: true,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-02T00:00:00Z',
  vars: mockProfileVars,
  commands: mockProfileCommands,
};

export const mockEmptyProfileDetails: ProfileDetails = {
  id: 'profile-5',
  name: 'Empty Profile',
  description: 'An empty profile for testing',
  isDefault: false,
  createdAt: '2025-01-07T00:00:00Z',
  updatedAt: '2025-01-07T00:00:00Z',
  vars: [],
  commands: [],
};

export const mockLocalDevProfileDetails: ProfileDetails = {
  id: 'profile-2',
  name: 'Local Development',
  description: null,
  isDefault: false,
  createdAt: '2025-01-03T00:00:00Z',
  updatedAt: '2025-01-03T00:00:00Z',
  vars: [
    {
      key: 'DATABASE_URL',
      value: 'postgresql://localhost:5432/dev',
      isSecret: false,
      createdAt: '2025-01-03T00:00:00Z',
      updatedAt: '2025-01-03T00:00:00Z',
    },
    {
      key: 'REDIS_URL',
      value: 'redis://localhost:6379',
      isSecret: false,
      createdAt: '2025-01-03T00:00:00Z',
      updatedAt: '2025-01-03T00:00:00Z',
    },
    {
      key: 'DEBUG',
      value: 'true',
      isSecret: false,
      createdAt: '2025-01-03T00:00:00Z',
      updatedAt: '2025-01-03T00:00:00Z',
    },
  ],
  commands: [],
};

export const mockStagingProfileDetails: ProfileDetails = {
  id: 'profile-3',
  name: 'Staging Environment',
  description: 'Staging environment with test credentials and staging database connection',
  isDefault: false,
  createdAt: '2025-01-04T00:00:00Z',
  updatedAt: '2025-01-05T00:00:00Z',
  vars: [
    {
      key: 'NODE_ENV',
      value: 'staging',
      isSecret: false,
      createdAt: '2025-01-04T00:00:00Z',
      updatedAt: '2025-01-04T00:00:00Z',
    },
    {
      key: 'API_URL',
      value: 'https://staging-api.example.com',
      isSecret: false,
      createdAt: '2025-01-04T00:00:00Z',
      updatedAt: '2025-01-04T00:00:00Z',
    },
    {
      key: 'DATABASE_URL',
      value: '***',
      isSecret: true,
      createdAt: '2025-01-04T00:00:00Z',
      updatedAt: '2025-01-04T00:00:00Z',
    },
  ],
  commands: [
    { sequence: 0, command: 'npm ci' },
    { sequence: 1, command: 'npm run migrate' },
    { sequence: 2, command: 'npm run seed:staging' },
  ],
};
