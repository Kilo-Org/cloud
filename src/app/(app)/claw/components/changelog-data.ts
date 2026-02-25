type ChangelogCategory = 'feature' | 'bugfix';
type ChangelogDeployHint = 'redeploy_suggested' | 'redeploy_required' | null;

export type ChangelogEntry = {
  date: string; // ISO date string, e.g. "2026-02-18"
  description: string;
  category: ChangelogCategory;
  deployHint: ChangelogDeployHint;
};

// Newest entries first. Developers add new entries to the top of this array.
export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    date: '2026-02-25',
    description:
      'Adjust tools.exec.security from deny to allowlist. Asking the agent to exec commands will trigger approval prompts in the Control UI.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-02-24',
    description:
      'Improve OpenClaw restart handling when restarts are triggered via the OpenClaw Control UI.',
    category: 'bugfix',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-02-23',
    description:
      'Redesigned dashboard: live gateway process status, added ability to restart OpenClaw gateway.',
    category: 'feature',
    deployHint: null,
  },
  {
    date: '2026-02-23',
    description: 'Deploy OpenClaw 2026.2.22. Added device pairing support to the dashboard.',
    category: 'feature',
    deployHint: 'redeploy_required',
  },
  {
    date: '2026-02-23',
    description:
      'OpenClaw now binds only to the loopback interface and is managed by a Kilo controller.',
    category: 'feature',
    deployHint: 'redeploy_required',
  },
  {
    date: '2026-02-20',
    description:
      'Added OpenClaw Doctor: run diagnostics and auto-fix from the dashboard. Renamed "Restart Gateway" to "Redeploy" to reflect actual behavior.',
    category: 'feature',
    deployHint: null,
  },
  {
    date: '2026-02-19',
    description: 'Added Discord and Slack channel configuration',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-02-18',
    description: 'Fixed an issue where pending pair requests were not displayed',
    category: 'bugfix',
    deployHint: null,
  },
  {
    date: '2026-02-18',
    description: 'Initial support for Telegram Channel pairing',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-02-17',
    description: 'Fixed errors on stopping an instance',
    category: 'bugfix',
    deployHint: null,
  },
];
