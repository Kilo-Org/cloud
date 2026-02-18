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
