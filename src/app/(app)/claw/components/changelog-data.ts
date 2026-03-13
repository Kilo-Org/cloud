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
    date: '2026-03-12',
    description:
      'Added support for Google Account and GitHub machine user connections. Connect your Google account for Gmail, Calendar, and Docs access. Add a GitHub identity so your bot can clone repos, push commits, and open PRs.',
    category: 'feature',
    deployHint: 'redeploy_required',
  },
  {
    date: '2026-03-10',
    description:
      'New instances now redirect pip and uv package installs to the persistent volume so packages survive restarts. pip uses /root/.pip-global via PYTHONUSERBASE; uv uses /root/.uv for tools and cache. uv is now pre-installed in the base image. Only applies to newly provisioned instances.',
    category: 'feature',
    deployHint: null,
  },
  {
    date: '2026-03-10',
    description:
      'New instances now redirect npm global installs to the persistent volume (/root/.npm-global) so packages installed via `npm install -g` survive restarts. Only applies to newly provisioned instances.',
    category: 'feature',
    deployHint: null,
  },
  {
    date: '2026-03-10',
    description: 'Updated OpenClaw to 2026.3.8.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-09',
    description:
      'Added headless Chromium browser support. OpenClaw\'s built-in browser tool now works out of the box for web browsing, screenshots, and CDP automation. Requires the "full" tool profile.',
    category: 'feature',
    deployHint: 'redeploy_required',
  },
  {
    date: '2026-03-05',
    description:
      'New deploys now default to the "full" tool profile, giving agents access to all tools including exec, filesystem, web search, and messaging. Existing instances can change their profile in the Control UI under Settings > Config > Tools > Tool Profile.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-05',
    description:
      'Added Go 1.26, gog (gogcli), goplaces, blogwatcher, xurl, gifgrep, and summarize to the default image. Go is available at runtime for installing additional tools via `go install`.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-04',
    description: 'Updated OpenClaw to 2026.3.2.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-04',
    description:
      'Added version pinning: you can now pin your KiloClaw instance to a specific OpenClaw version from the Settings tab. Choose your preferred version and variant to control when you upgrade.',
    category: 'feature',
    deployHint: null,
  },
  {
    date: '2026-03-01',
    description:
      'Fixed model picker showing unsupported models. If you encounter model-not-found errors, use Settings > Default Model to select a supported model and restart the gateway.',
    category: 'bugfix',
    deployHint: null,
  },
  {
    date: '2026-03-01',
    description:
      'Fixed an issue where only 2 models were visible in OpenClaw. All models currently available in openclaw are now visible after a redeploy.',
    category: 'bugfix',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-02-27',
    description:
      'Updated OpenClaw to 2026.2.26. Added 1Password CLI, build-essential, python3, ffmpeg, tmux, and mcporter to the default image.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-02-26',
    description:
      'Added Restore Default Config: rewrite openclaw.json from environment variables and restart the gateway without a full redeploy. Available in Settings > Danger Zone.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-02-26',
    description:
      'Updated OpenClaw to the latest version. Changing the default model in the dashboard now takes effect immediately without requiring a redeploy.',
    category: 'feature',
    deployHint: 'redeploy_required',
  },
  {
    date: '2026-02-26',
    description:
      'Added ripgrep (rg), GitHub CLI (gh), rsync, zstd, and ClawHub CLI to the default image.',
    category: 'feature',
    deployHint: null,
  },
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
