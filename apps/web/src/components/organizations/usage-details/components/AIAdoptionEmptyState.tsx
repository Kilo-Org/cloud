'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer } from 'vaul';
import { X, TrendingUp, Zap, Layers, Users, Target } from 'lucide-react';

export function AIAdoptionEmptyState() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <div className="relative">
        {/* Blurred placeholder content */}
        <div className="pointer-events-none opacity-40 blur-sm select-none">
          {/* Mock chart */}
          <div className="h-[180px] w-full rounded-lg border border-gray-800 bg-gray-900/50 p-4">
            <div className="flex h-full items-end justify-around gap-2">
              {[45, 52, 58, 65, 70, 75, 78].map((height, i) => (
                <div
                  key={i}
                  className="w-full rounded-t bg-gradient-to-t from-blue-600 to-green-500"
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
          </div>

          {/* Mock trend blocks */}
          <div className="mt-4 grid grid-cols-4 gap-4">
            {[
              { label: 'Total', value: '+12.5%' },
              { label: 'Frequency', value: '+8.2%' },
              { label: 'Depth', value: '+15.1%' },
              { label: 'Coverage', value: '+18.3%' },
            ].map((block, i) => (
              <div key={i} className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                <div className="text-xs text-gray-400">{block.label}</div>
                <div className="mt-1 text-lg font-bold text-green-500">{block.value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Overlay with message */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="max-w-md rounded-lg border border-gray-700 bg-gray-900/95 p-6 text-center shadow-xl backdrop-blur-sm">
            <div className="mb-4 flex justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-purple-500/20">
                <TrendingUp className="h-6 w-6 text-purple-400" />
              </div>
            </div>
            <h3 className="mb-2 text-lg font-semibold">AI Adoption Score</h3>
            <p className="text-muted-foreground mb-4 text-sm">
              We're collecting data for your organization. Check back in a few days to see your
              team's AI adoption metrics and trends.
            </p>
            <Button onClick={() => setDrawerOpen(true)} className="w-full">
              Learn More About AI Adoption
            </Button>
          </div>
        </div>
      </div>

      {/* Learn More Drawer */}
      <Drawer.Root open={drawerOpen} onOpenChange={setDrawerOpen} direction="right">
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
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/20">
                    <TrendingUp className="h-5 w-5 text-purple-400" />
                  </div>
                  <div>
                    <Drawer.Title className="text-xl font-semibold">AI Adoption Score</Drawer.Title>
                    <Drawer.Description className="text-muted-foreground mt-1 text-sm">
                      Track your organization's AI integration progress
                    </Drawer.Description>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDrawerOpen(false)}
                  className="ml-4 flex-shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-6 pt-6 pb-10">
                <div className="space-y-6">
                  {/* Overview */}
                  <div>
                    <h3 className="mb-3 text-lg font-semibold">What is the AI Adoption Score?</h3>
                    <p className="mb-4 text-sm text-gray-300">
                      The AI Adoption Score measures how effectively your team is integrating AI
                      tools into their daily workflows. It's calculated across three key dimensions:
                    </p>
                  </div>

                  {/* Metrics Breakdown */}
                  <div className="space-y-4">
                    {/* Frequency */}
                    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <Zap className="h-4 w-4 text-blue-400" />
                        <h4 className="font-semibold">Frequency (40 points)</h4>
                      </div>
                      <p className="mb-2 text-sm text-gray-300">
                        How often your team uses AI tools daily
                      </p>
                      <ul className="ml-4 space-y-1 text-xs text-gray-400">
                        <li>• Agent interactions per day</li>
                        <li>• Autocomplete acceptances</li>
                        <li>• Cloud Agent sessions</li>
                        <li>• Code review runs</li>
                      </ul>
                    </div>

                    {/* Depth */}
                    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <Layers className="h-4 w-4 text-green-400" />
                        <h4 className="font-semibold">Depth (40 points)</h4>
                      </div>
                      <p className="mb-2 text-sm text-gray-300">
                        How deeply AI is integrated into workflows
                      </p>
                      <ul className="ml-4 space-y-1 text-xs text-gray-400">
                        <li>• Queries per hour worked</li>
                        <li>• Suggestion acceptance rate</li>
                        <li>• Multi-agent workflow chains</li>
                      </ul>
                    </div>

                    {/* Coverage */}
                    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <Users className="h-4 w-4 text-amber-400" />
                        <h4 className="font-semibold">Coverage (20 points)</h4>
                      </div>
                      <p className="mb-2 text-sm text-gray-300">
                        How broadly AI is adopted across your team
                      </p>
                      <ul className="ml-4 space-y-1 text-xs text-gray-400">
                        <li>• Percentage of users active weekly</li>
                        <li>• Multi-agent adoption rate</li>
                        <li>• Consistency across weekdays</li>
                      </ul>
                    </div>

                    {/* Total */}
                    <div className="rounded-lg border border-gray-700 bg-gradient-to-r from-blue-900/20 to-green-900/20 p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <Target className="h-4 w-4 text-purple-400" />
                        <h4 className="font-semibold">Total Score (100 points)</h4>
                      </div>
                      <p className="text-sm text-gray-300">
                        The sum of all three metrics, representing your organization's overall AI
                        integration maturity
                      </p>
                    </div>
                  </div>

                  {/* Getting Started */}
                  <div className="rounded-lg border border-blue-800/50 bg-blue-900/20 p-4">
                    <h4 className="mb-2 font-semibold">Getting Started</h4>
                    <p className="text-sm text-gray-300">
                      Your AI Adoption Score will become available once we've collected at least 3
                      days of usage data. In the meantime, encourage your team to:
                    </p>
                    <ul className="mt-2 ml-4 space-y-1 text-sm text-gray-300">
                      <li>• Use Kilo's AI agents for daily coding tasks</li>
                      <li>• Enable autocomplete in their IDE</li>
                      <li>• Try the Cloud Agent for complex workflows</li>
                      <li>• Set up code reviews with the Reviewer Agent</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}
