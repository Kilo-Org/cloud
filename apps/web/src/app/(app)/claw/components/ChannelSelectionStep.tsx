'use client';

import { useState } from 'react';
import { ChevronRight, ExternalLink, PlayCircle } from 'lucide-react';
import { validateFieldValue } from '@kilocode/kiloclaw-secret-catalog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OnboardingStepView } from './OnboardingStepView';
import { DiscordIcon } from './icons/DiscordIcon';
import { ChannelTokenInput } from './ChannelTokenInput';
import { SlackIcon } from './icons/SlackIcon';
import { TelegramIcon } from './icons/TelegramIcon';

type ChannelId = 'telegram' | 'discord' | 'slack';

type ChannelOption = {
  id: ChannelId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  effort: 1 | 2 | 3;
  effortColor: 'emerald' | 'amber';
  recommended?: boolean;
};

const CHANNEL_OPTIONS: ChannelOption[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    icon: TelegramIcon,
    description:
      'Chat with your bot directly in Telegram. Just open a conversation with it \u2014 no workspace, no admin access, ready in seconds.',
    effort: 1,
    effortColor: 'emerald',
    recommended: true,
  },
  {
    id: 'discord',
    label: 'Discord',
    icon: DiscordIcon,
    description:
      'Talk to your bot in a Discord server channel. Requires adding it as a bot to your server.',
    effort: 3,
    effortColor: 'amber',
  },
  {
    id: 'slack',
    label: 'Slack',
    icon: SlackIcon,
    description:
      'Talk to your bot in a Slack channel. Requires installing it as an app in your workspace.',
    effort: 3,
    effortColor: 'amber',
  },
];

type SetupSectionProps = {
  token: string;
  onTokenChange: (value: string) => void;
};

/** Token field keys that belong to each channel. */
const CHANNEL_FIELD_KEYS: Record<ChannelId, { key: string; pattern: string }[]> = {
  telegram: [{ key: 'telegramBotToken', pattern: String.raw`^\d{8,}:[A-Za-z0-9_-]{30,50}$` }],
  discord: [
    {
      key: 'discordBotToken',
      pattern: String.raw`^[A-Za-z\d_-]{24,}?\.[A-Za-z\d_-]{4,}\.[A-Za-z\d_-]{25,}$`,
    },
  ],
  slack: [
    { key: 'slackBotToken', pattern: String.raw`^xoxb-[A-Za-z0-9-]{20,255}$` },
    { key: 'slackAppToken', pattern: String.raw`^xapp-[A-Za-z0-9-]{20,255}$` },
  ],
};

function isChannelValid(channelId: ChannelId | null, tokens: Record<string, string>): boolean {
  if (!channelId) return false;
  return CHANNEL_FIELD_KEYS[channelId].every(({ key, pattern }) =>
    validateFieldValue((tokens[key] ?? '').trim(), pattern)
  );
}

/** Return only the trimmed tokens belonging to the given channel. */
function pickChannelTokens(
  channelId: ChannelId,
  tokens: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key } of CHANNEL_FIELD_KEYS[channelId]) {
    const trimmed = (tokens[key] ?? '').trim();
    if (trimmed) result[key] = trimmed;
  }
  return result;
}

export function ChannelSelectionStepView({
  currentStep,
  totalSteps,
  instanceRunning,
  onSelect,
  onSkip,
  defaultSelected = null,
}: {
  currentStep: number;
  totalSteps: number;
  instanceRunning?: boolean;
  onSelect?: (channelId: ChannelId, tokens: Record<string, string>) => void;
  onSkip?: () => void;
  defaultSelected?: ChannelId | null;
}) {
  const [selected, setSelected] = useState<ChannelId | null>(defaultSelected);
  const [tokens, setTokens] = useState<Record<string, string>>({});

  const telegram = CHANNEL_OPTIONS[0];
  const others = CHANNEL_OPTIONS.slice(1);

  function setToken(key: string, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  const expandedSections: Partial<Record<ChannelId, React.ReactNode>> = {
    telegram: (
      <TelegramSetupSection
        token={tokens.telegramBotToken ?? ''}
        onTokenChange={v => setToken('telegramBotToken', v)}
      />
    ),
    discord: (
      <DiscordSetupSection
        token={tokens.discordBotToken ?? ''}
        onTokenChange={v => setToken('discordBotToken', v)}
      />
    ),
    slack: (
      <SlackSetupSection
        botToken={tokens.slackBotToken ?? ''}
        onBotTokenChange={v => setToken('slackBotToken', v)}
        appToken={tokens.slackAppToken ?? ''}
        onAppTokenChange={v => setToken('slackAppToken', v)}
      />
    ),
  };

  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      title="Where do you want to chat?"
      description="Pick where you'd like to talk to your KiloClaw bot. You can add more channels any time from settings."
      showProvisioningBanner={instanceRunning === false}
    >
      {telegram && (
        <ChannelCard
          option={telegram}
          isSelected={selected === telegram.id}
          onSelect={() => setSelected(telegram.id)}
          expandedContent={expandedSections[telegram.id]}
        />
      )}

      <div className="flex items-center gap-3">
        <div className="border-border flex-1 border-t" />
        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Other options
        </span>
        <div className="border-border flex-1 border-t" />
      </div>

      {others.map(option => (
        <ChannelCard
          key={option.id}
          option={option}
          isSelected={selected === option.id}
          onSelect={() => setSelected(option.id)}
          expandedContent={expandedSections[option.id]}
        />
      ))}

      <Button
        className="w-full bg-emerald-600 py-6 text-base text-white hover:bg-emerald-700"
        disabled={!isChannelValid(selected, tokens)}
        onClick={() => selected && onSelect?.(selected, pickChannelTokens(selected, tokens))}
      >
        Continue
        <ChevronRight className="ml-1 h-5 w-5" />
      </Button>

      <button
        type="button"
        className="text-muted-foreground hover:text-foreground mx-auto text-sm transition-colors"
        onClick={() => onSkip?.()}
      >
        Skip for now
      </button>
    </OnboardingStepView>
  );
}

function ChannelCard({
  option,
  isSelected,
  onSelect,
  expandedContent,
}: {
  option: ChannelOption;
  isSelected: boolean;
  onSelect: () => void;
  expandedContent?: React.ReactNode;
}) {
  const Icon = option.icon;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-xl border transition-colors',
        isSelected
          ? 'border-blue-500/60 bg-blue-500/8'
          : 'border-border hover:border-muted-foreground/40'
      )}
    >
      <button type="button" onClick={onSelect} className="flex cursor-pointer gap-4 p-5 text-left">
        <div
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg',
            isSelected ? 'bg-sky-600/20' : 'bg-muted'
          )}
        >
          <Icon className="h-6 w-6" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold">{option.label}</span>
            {option.recommended && (
              <span className="rounded-full border border-emerald-700 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-400 uppercase">
                Recommended
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-[#5a5b64]">{option.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <EffortIndicator level={option.effort} color={option.effortColor} />
          <RadioIndicator checked={isSelected} />
        </div>
      </button>

      {isSelected && expandedContent && <div className="px-5 pb-5">{expandedContent}</div>}
    </div>
  );
}

function ChannelSetupSection({
  heading,
  children,
  videoGuideUrl,
  tokenInputs,
}: {
  heading: string;
  children: React.ReactNode;
  videoGuideUrl?: string;
  tokenInputs: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="border-border border-t" />
      <h3 className="text-muted-foreground text-sm font-bold tracking-wider uppercase">
        {heading}
      </h3>
      <div className="flex flex-col gap-4">{children}</div>
      {videoGuideUrl && (
        <a
          href={videoGuideUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-muted-foreground flex items-center gap-2 text-xs text-[#5a5b64] transition-colors"
        >
          <PlayCircle className="h-5 w-5 shrink-0 text-blue-400" />
          Prefer a walkthrough? Watch a short video guide
        </a>
      )}
      {tokenInputs}
    </div>
  );
}

function NumberedStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="bg-muted text-muted-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
        {n}
      </span>
      <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">{children}</p>
    </div>
  );
}

function TelegramSetupSection({ token, onTokenChange }: SetupSectionProps) {
  return (
    <ChannelSetupSection
      heading="Create your bot token"
      videoGuideUrl="https://youtu.be/t2iTYbDsSds"
      tokenInputs={
        <ChannelTokenInput
          id="onboarding-telegram-token"
          placeholder="Paste your bot token here"
          value={token}
          onChange={onTokenChange}
          maxLength={100}
        />
      }
    >
      <NumberedStep n={1}>
        Open Telegram and start a chat with{' '}
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300"
        >
          @BotFather
          <ExternalLink className="mb-0.5 ml-0.5 inline h-3 w-3" />
        </a>{' '}
        &mdash; make sure the handle is exactly{' '}
        <strong className="text-foreground">@BotFather</strong>.
      </NumberedStep>
      <NumberedStep n={2}>
        Run <code className="rounded bg-purple-900/40 px-1.5 py-0.5 text-purple-300">/newbot</code>,
        follow the prompts, and copy the token it gives you.
      </NumberedStep>
    </ChannelSetupSection>
  );
}

function DiscordSetupSection({ token, onTokenChange }: SetupSectionProps) {
  return (
    <ChannelSetupSection
      heading="Get your bot token"
      videoGuideUrl="https://youtu.be/t2iTYbDsSds"
      tokenInputs={
        <ChannelTokenInput
          id="onboarding-discord-token"
          placeholder="Paste your Discord bot token..."
          value={token}
          onChange={onTokenChange}
          maxLength={100}
        />
      }
    >
      <NumberedStep n={1}>
        Go to the{' '}
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300"
        >
          Discord Developer Portal
          <ExternalLink className="mb-0.5 ml-0.5 inline h-3 w-3" />
        </a>
        , create a New Application, then click <strong className="text-foreground">Bot</strong> in
        the sidebar and add a bot.
      </NumberedStep>
      <NumberedStep n={2}>
        On the Bot page, scroll to{' '}
        <strong className="text-foreground">Privileged Gateway Intents</strong> and enable{' '}
        <strong className="text-foreground">Message Content Intent</strong>.
      </NumberedStep>
      <NumberedStep n={3}>
        Click{' '}
        <code className="rounded bg-purple-900/40 px-1.5 py-0.5 text-purple-300">Reset Token</code>{' '}
        on the Bot page and copy the token that appears.
      </NumberedStep>
    </ChannelSetupSection>
  );
}

function SlackSetupSection({
  botToken,
  onBotTokenChange,
  appToken,
  onAppTokenChange,
}: {
  botToken: string;
  onBotTokenChange: (value: string) => void;
  appToken: string;
  onAppTokenChange: (value: string) => void;
}) {
  const botTokenPrefixError = botToken.length > 0 && !botToken.startsWith('xoxb-');
  const appTokenPrefixError = appToken.length > 0 && !appToken.startsWith('xapp-');

  return (
    <ChannelSetupSection
      heading="Get your tokens"
      videoGuideUrl="https://youtu.be/t2iTYbDsSds"
      tokenInputs={
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-foreground text-sm font-semibold">Bot Token</span>
            <ChannelTokenInput
              id="onboarding-slack-bot-token"
              placeholder="xoxb-"
              value={botToken}
              onChange={onBotTokenChange}
              maxLength={200}
            />
            <span
              className={cn('text-xs', botTokenPrefixError ? 'text-red-400' : 'text-[#5a5b64]')}
            >
              {botTokenPrefixError ? 'Must start with xoxb-' : 'From OAuth & Permissions'}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-foreground text-sm font-semibold">App Token</span>
            <ChannelTokenInput
              id="onboarding-slack-app-token"
              placeholder="xapp-"
              value={appToken}
              onChange={onAppTokenChange}
              maxLength={200}
            />
            <span
              className={cn('text-xs', appTokenPrefixError ? 'text-red-400' : 'text-[#5a5b64]')}
            >
              {appTokenPrefixError
                ? 'Must start with xapp-'
                : 'From Basic Information \u2192 App-Level Tokens'}
            </span>
          </div>
        </div>
      }
    >
      <NumberedStep n={1}>
        Go to{' '}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300"
        >
          Slack App Management
          <ExternalLink className="mb-0.5 ml-0.5 inline h-3 w-3" />
        </a>{' '}
        and create or open your app.
      </NumberedStep>
      <NumberedStep n={2}>
        Under <strong className="text-foreground">OAuth &amp; Permissions</strong>, copy the{' '}
        <strong className="text-foreground">Bot Token</strong> &mdash; it starts with{' '}
        <code className="rounded bg-purple-900/40 px-1.5 py-0.5 text-purple-300">xoxb-</code>.
      </NumberedStep>
      <NumberedStep n={3}>
        Under <strong className="text-foreground">Basic Information &rarr; App-Level Tokens</strong>
        , generate and copy the <strong className="text-foreground">App Token</strong> &mdash; it
        starts with{' '}
        <code className="rounded bg-purple-900/40 px-1.5 py-0.5 text-purple-300">xapp-</code>.
      </NumberedStep>
    </ChannelSetupSection>
  );
}

function RadioIndicator({ checked }: { checked: boolean }) {
  return (
    <div
      className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
        checked ? 'border-blue-500 bg-blue-500' : 'border-muted-foreground/40'
      )}
    >
      {checked && <div className="h-2 w-2 rounded-full bg-white" />}
    </div>
  );
}

function EffortIndicator({ level, color }: { level: 1 | 2 | 3; color: 'emerald' | 'amber' }) {
  const filledClass = color === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500';

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Effort</span>
      <div className="flex gap-1">
        {[1, 2, 3].map(i => (
          <span
            key={i}
            className={cn('h-2 w-4 rounded-full', i <= level ? filledClass : 'bg-muted')}
          />
        ))}
      </div>
    </div>
  );
}
