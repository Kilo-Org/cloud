type ChangelogCategory = 'feature' | 'bugfix';
type ChangelogDeployHint = 'redeploy_suggested' | 'redeploy_required' | 'upgrade_required' | null;

export type ChangelogEntry = {
  date: string; // ISO date string, e.g. "2026-02-18"
  description: string;
  category: ChangelogCategory;
  deployHint: ChangelogDeployHint;
};

// Newest entries first. Developers add new entries to the top of this array.
export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    date: '2026-04-06',
    description: 'Updated OpenClaw to 2026.4.5.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-04-03',
    description: 'Updated OpenClaw to 2026.3.28.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-04-03',
    description:
      'Fixed an issue where the plugins.allow section in openclaw.json caused channels to be silently dropped. If you experience issues with Telegram/Discord/Slack ask your agent: "If my openclaw.json has a plugins.allow section and the only entry is \'openclaw-channel-streamchat\', delete the entire plugins.allow section."',
    category: 'bugfix',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-04-01',
    description: 'Updated OpenClaw to 2026.3.24.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-31',
    description:
      'Added Webhook Integration — receive webhook events as messages in your KiloClaw chat. Any service that can send an HTTP POST (CI/CD pipelines, monitoring tools, form builders, custom scripts, etc.) can trigger your bot to take action. Enable it in Settings > Webhook Integration. Supports custom prompt templates and optional webhook authentication.',
    category: 'feature',
    deployHint: null,
  },
  {
    date: '2026-03-27',
    description:
      'Added Linear integration. Connect your Linear API Key in Settings to give your agent access to all Linear features, via the Linear MCP server.',
    category: 'feature',
    deployHint: 'redeploy_required',
  },
  {
    date: '2026-03-27',
    description:
      'Additional Secrets — all OpenClaw SecretRef credential paths are now supported. Add any API key, token, or credential in Settings > Additional Secrets and it will be encrypted and patched into your openclaw.json config at the specified path on every boot. Supports model providers, channels, plugins, web search, and more.',
    category: 'feature',
    deployHint: 'upgrade_required',
  },
  {
    date: '2026-03-26',
    description:
      'Added real-time Chat tab — talk to your KiloClaw bot directly from the dashboard.',
    category: 'feature',
    deployHint: 'upgrade_required',
  },
  {
    date: '2026-03-26',
    description:
      'Added "Recover with Kilo" — diagnose and fix stuck or broken instances using the Kilo CLI agent directly from the dashboard. Describe the problem, and the agent runs autonomously to resolve it. Monitor output in real time, cancel runs, and view run history.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-24',
    description:
      'Fixed Kilo CLI discovery — OpenClaw now knows about the kilo CLI on all instances. Previously, instances provisioned before the CLI was added did not advertise it in TOOLS.md, so the agent could not find it.',
    category: 'bugfix',
    deployHint: 'upgrade_required',
  },
  {
    date: '2026-03-23',
    description:
      'Added Brave Search integration. Connect your Brave Search API key in Settings to enable the web_search tool. Brave Search removed their free tier, so an API key is now required.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-19',
    description:
      'Added 1Password integration. Connect a service account token in Settings to give your agent access to the op CLI for looking up credentials and managing vault items.',
    category: 'feature',
    deployHint: 'upgrade_required',
  },
  {
    date: '2026-03-19',
    description:
      'Added AgentCard integration. Connect your AgentCard.sh credentials in Settings to give your bot the ability to create and spend virtual debit cards via mcporter.',
    category: 'feature',
    deployHint: 'redeploy_required',
  },
  {
    date: '2026-03-17',
    description: 'Updated 1Password CLI to 2.33.0.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-17',
    description:
      'New workspace file editor — browse and edit all files in /root/.openclaw/ from the dashboard, including credentials and backups. Replaces the old single-file config editor.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-17',
    description:
      'Reduced OpenClaw startup overhead by disabling unnecessary CLI self-respawn, enabled Node compile cache for faster repeated CLI runs, and tightened state directory permissions.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-16',
    description: 'Updated OpenClaw to 2026.3.13.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
  {
    date: '2026-03-16',
    description: 'Updated OpenClaw to 2026.3.11, summarize CLI to 0.12.0, and gogcli to 0.12.0.',
    category: 'feature',
    deployHint: 'redeploy_suggested',
  },
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
