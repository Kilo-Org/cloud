'use client';

import { Drawer } from 'vaul';
import { X, Zap, Layers, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useMemo } from 'react';
import Link from 'next/link';

type MetricDetailDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metric: 'frequency' | 'depth' | 'coverage' | null;
  organizationId: string;
  chartData: Array<{
    date: string;
    timestamp: number;
    Frequency: number;
    Depth: number;
    Coverage: number;
    total: number;
  }>;
};

type MetricOption = {
  title: string;
  subtitle: string;
  description: React.ReactNode;
  action: string | null;
};

type MetricInfo = {
  title: string;
  icon: typeof Zap;
  color: string;
  dataKey: 'Frequency' | 'Depth' | 'Coverage';
  improvementTitle: string;
  improvementGoal: string;
  options: MetricOption[];
};

const getMetricInfo = (
  organizationId: string
): Record<'frequency' | 'depth' | 'coverage', MetricInfo> => ({
  frequency: {
    title: 'Frequency Score',
    icon: Zap,
    color: '#3b82f6',
    dataKey: 'Frequency' as const,
    improvementTitle: 'Improving Frequency Scores (Consistency)',
    improvementGoal:
      'Help developers build AI into their daily workflow, not just reach for it on hard problems.',
    options: [
      {
        title: 'Expand Beyond the IDE',
        subtitle: 'Focus on the CLI',
        description:
          "A lot of dev work happens in the terminal—git operations, debugging, scripting. The CLI brings AI to those contexts. Teams that use both surfaces tend to show higher daily engagement because AI is available wherever they're working.",
        action: 'npm install -g @kilocode/cli',
      },
      {
        title: 'Start with Autocomplete',
        subtitle: 'Focus on Acceptance Rate',
        description:
          'Autocomplete is low-friction by design. Encouraging your team to lean on it for boilerplate, repetitive patterns, and common syntax builds the muscle memory that leads to consistent usage.',
        action: null,
      },
      {
        title: 'Tie AI to Existing Routines',
        subtitle: 'Daily Habits',
        description:
          "The teams with the strongest Frequency scores usually aren't doing anything flashy—they've just woven AI into things they already do. Stand-up prep. Quick context checks on unfamiliar code. PR descriptions. Small, repeated use cases add up faster than occasional heavy lifts.",
        action: null,
      },
    ],
  },
  depth: {
    title: 'Depth Score',
    icon: Layers,
    color: '#10b981',
    dataKey: 'Depth' as const,
    improvementTitle: 'Improving Depth Scores (Integration & Trust)',
    improvementGoal: 'Move AI from a side tool to an integrated part of how your team ships code.',
    options: [
      {
        title: 'Chain Your Workflows',
        subtitle: 'The "Chain" Workflow',
        description: (
          <>
            Depth increases when AI touches multiple stages of the same task. A common pattern: use
            Architect mode to plan a feature, the Code mode to build it, and{' '}
            <Link
              href={`/organizations/${organizationId}/code-reviews`}
              className="text-blue-400 hover:underline"
            >
              Code Reviewer
            </Link>{' '}
            to critique it. Each handoff reinforces context and keeps AI in the loop from idea to
            merge.
          </>
        ),
        action:
          'Tip: Linking coding → review → deploy actions significantly boosts your Depth score.',
      },
      {
        title: 'Give AI Better Context',
        subtitle: 'Context & Indexing',
        description: (
          <>
            If acceptance rates are low, the issue is often context—the AI is making suggestions
            without understanding your codebase.{' '}
            <Link
              href={`/organizations/${organizationId}/code-indexing`}
              className="text-blue-400 hover:underline"
            >
              Managed Indexing
            </Link>{' '}
            fixes this by giving the model vector-backed search across your repo. Better context
            means more relevant suggestions, which builds the trust that drives deeper usage.
          </>
        ),
        action: null,
      },
      {
        title: 'Validate AI Output in Real Environments',
        subtitle: 'Deployment Testing',
        description: (
          <>
            Generated code that never runs is hard to trust.{' '}
            <Link
              href={`/organizations/${organizationId}/deploy`}
              className="text-blue-400 hover:underline"
            >
              Kilo Deploy
            </Link>{' '}
            lets you spin up a live URL for branches of your project so that your team can verify
            changes against live URLs before merging. Teams that test AI output this way tend to
            retain more of that code long-term.
          </>
        ),
        action: null,
      },
    ],
  },
  coverage: {
    title: 'Coverage Score',
    icon: Users,
    color: '#f59e0b',
    dataKey: 'Coverage' as const,
    improvementTitle: 'Improving Coverage Scores (Breadth of Adoption)',
    improvementGoal: 'Get more of your team using more of the platform.',
    options: [
      {
        title: 'Introduce Specialist Agents',
        subtitle: 'Multi-Agent Orchestration',
        description:
          "Most teams start with Code mode and stop there. But Kilo's other modes, Orchestrator, Architect, Debug, and Ask, allow you agentically delegate and execute subtasks over long-horizon projects. This increases efficacy and improves trust in AI-facilitated tasking.",
        action: null,
      },
      {
        title: 'Activate Unused Seats',
        subtitle: 'Team Onboarding',
        description: (
          <>
            Coverage is partly a numbers game. If you have team members who haven't logged in or
            aren't using the tool, your score will reflect that. Check your{' '}
            <Link
              href={`/organizations/${organizationId}`}
              className="text-blue-400 hover:underline"
            >
              Organization Dashboard
            </Link>{' '}
            for inactive seats and consider whether those folks need a nudge, a walkthrough, or just
            a reminder that access exists.
          </>
        ),
        action: null,
      },
      {
        title: 'Spread Usage Across the Week',
        subtitle: 'Consistency Across the Week',
        description: (
          <>
            Spiky usage—heavy on Mondays, quiet the rest of the week—limits your Coverage score. One
            way to smooth this out: make{' '}
            <Link
              href={`/organizations/${organizationId}/code-reviews`}
              className="text-blue-400 hover:underline"
            >
              Code Reviewer
            </Link>{' '}
            part of your PR process. Reviews happen throughout the week, so AI usage naturally
            follows.
          </>
        ),
        action: null,
      },
    ],
  },
});

export function MetricDetailDrawer({
  open,
  onOpenChange,
  metric,
  organizationId,
  chartData,
}: MetricDetailDrawerProps) {
  const metricInfo = useMemo(() => getMetricInfo(organizationId), [organizationId]);

  // Filter chart data to only show the selected metric
  const metricChartData = useMemo(() => {
    if (!metric) return [];
    const info = metricInfo[metric];
    return chartData.map(d => ({
      date: d.date,
      value: d[info.dataKey],
    }));
  }, [chartData, metric, metricInfo]);

  if (!metric) return null;

  const info = metricInfo[metric];
  const IconComponent = info.icon;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content
          className="fixed top-2 right-2 bottom-2 z-50 flex w-full max-w-2xl outline-none"
          style={{ '--initial-transform': 'calc(100% + 8px)' } as React.CSSProperties}
        >
          <div className="flex h-full w-full grow flex-col rounded-[16px] border-l-2 border-l-[#cccccc1f] bg-[#111]">
            {/* Header */}
            <div className="border-border flex flex-shrink-0 items-start justify-between border-b px-6 py-4">
              <div className="flex flex-1 items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${info.color}20` }}
                >
                  <IconComponent className="h-5 w-5" style={{ color: info.color }} />
                </div>
                <div>
                  <Drawer.Title className="text-xl font-semibold">{info.title}</Drawer.Title>
                  <Drawer.Description className="text-muted-foreground mt-1 text-sm">
                    Detailed analysis and improvement suggestions
                  </Drawer.Description>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="ml-4 flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 pt-6 pb-10">
              {/* Condensed Chart */}
              <div className="mb-8">
                <h3 className="mb-3 text-sm font-medium text-gray-400">Trend Over Time</h3>
                <div className="h-32 w-full rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={metricChartData}
                      margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                      <XAxis
                        dataKey="date"
                        stroke="#a1a1a1"
                        tick={{ fontSize: 9 }}
                        interval="preserveStartEnd"
                      />
                      <YAxis stroke="#a1a1a1" tick={{ fontSize: 9 }} width={30} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'rgba(17, 24, 39, 0.95)',
                          border: '1px solid #374151',
                          borderRadius: '8px',
                        }}
                      />
                      <Bar
                        dataKey="value"
                        fill={info.color}
                        radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Improvement Section */}
              <div>
                <h3 className="mb-2 text-lg font-semibold">{info.improvementTitle}</h3>
                <p className="text-muted-foreground mb-6 text-sm">
                  <strong>Goal:</strong> {info.improvementGoal}
                </p>

                <div className="space-y-6">
                  {info.options.map((option, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-gray-800 bg-gray-900/50 p-4"
                    >
                      <div className="mb-2">
                        <h4 className="font-semibold">{option.title}</h4>
                        <p className="text-xs text-gray-400">{option.subtitle}</p>
                      </div>
                      <p className="mb-3 text-sm text-gray-300">{option.description}</p>
                      {option.action && (
                        <div className="rounded bg-gray-800/50 px-3 py-2">
                          <code className="text-xs text-blue-400">{option.action}</code>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
