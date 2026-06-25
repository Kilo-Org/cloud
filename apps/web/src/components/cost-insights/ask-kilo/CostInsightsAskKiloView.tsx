'use client';

import { useState, type FormEvent } from 'react';
import { BarChart3, ChevronDown, ChevronUp, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const askKiloChartData = [
  { date: 'Jun 18', cost: 1.42, color: 'var(--chart-1)' },
  { date: 'Jun 19', cost: 0.28, color: 'var(--chart-2)' },
  { date: 'Jun 20', cost: 0.17, color: 'var(--chart-3)' },
  { date: 'Jun 21', cost: 0, color: 'var(--chart-4)' },
  { date: 'Jun 22', cost: 0, color: 'var(--chart-5)' },
  { date: 'Jun 23', cost: 0.45, color: 'var(--chart-1)' },
  { date: 'Jun 24', cost: 0.31, color: 'var(--chart-2)' },
];

export function CostInsightsAskKiloView({
  initialQuestion = 'Create a graph of my costs for the last week',
}: {
  initialQuestion?: string;
}) {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState([{ id: 'initial', question: initialQuestion }]);
  const [chartExpanded, setChartExpanded] = useState(true);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;
    setMessages(currentMessages => [
      ...currentMessages,
      { id: `question-${currentMessages.length}`, question: trimmedQuestion },
    ]);
    setQuestion('');
  }

  return (
    <section className="flex min-h-[calc(100vh-15rem)] flex-col" aria-label="Ask Kilo conversation">
      <div className="flex-1 space-y-6">
        {messages.map(message => (
          <div key={message.id} className="space-y-6">
            <div className="ml-auto max-w-2xl rounded-xl bg-surface-selected px-4 py-3 type-body">
              {message.question}
            </div>
            <div className="space-y-4">
              <div className="border-border bg-card overflow-hidden rounded-xl border">
                <button
                  type="button"
                  onClick={() => setChartExpanded(expanded => !expanded)}
                  className="focus-visible:ring-ring flex min-h-control-touch w-full items-center gap-2 border-b border-border px-4 text-left focus-visible:ring-2 focus-visible:outline-none"
                  aria-expanded={chartExpanded}
                >
                  <BarChart3 className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="type-body font-medium">Cost over time</span>
                  <span className="ml-auto type-label text-muted-foreground">Chart</span>
                  {chartExpanded ? (
                    <ChevronUp className="size-4 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                </button>
                {chartExpanded && (
                  <div className="p-4">
                    <p className="type-label text-muted-foreground">
                      Model usage · Cost · Jun 18, 2026 to Jun 24, 2026
                    </p>
                    <h3 className="type-body mt-5 font-medium">Cost by date</h3>
                    <figure className="mt-3">
                      <figcaption className="sr-only">
                        Daily cost from June 18 to June 24. Peak cost was $1.42 on June 18. No spend
                        occurred June 21 or June 22.
                      </figcaption>
                      <div className="grid h-64 grid-cols-[2.75rem_minmax(0,1fr)] gap-2 sm:h-80">
                        <div className="type-label text-muted-foreground flex flex-col justify-between pb-7 text-right font-mono tabular-nums">
                          {[1.6, 1.2, 0.8, 0.4, 0].map(value => (
                            <span key={value}>${value.toFixed(2)}</span>
                          ))}
                        </div>
                        <div className="relative grid grid-cols-7 gap-2 border-b border-border-strong pb-7 sm:gap-4">
                          <div
                            className="pointer-events-none absolute inset-x-0 top-0 bottom-7 flex flex-col justify-between"
                            aria-hidden="true"
                          >
                            {[0, 1, 2, 3, 4].map(line => (
                              <span
                                key={line}
                                className="border-border block border-t border-dashed"
                              />
                            ))}
                          </div>
                          {askKiloChartData.map(item => (
                            <div
                              key={item.date}
                              className="relative flex min-w-0 items-end justify-center"
                            >
                              <div
                                className="w-full max-w-20 rounded-t-sm"
                                style={{
                                  height: `${(item.cost / 1.6) * 100}%`,
                                  backgroundColor: item.color,
                                }}
                              />
                              <span className="type-label text-muted-foreground absolute top-full mt-2 whitespace-nowrap font-mono max-sm:text-[10px]">
                                {item.date.replace('Jun ', '')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="type-label text-muted-foreground mt-2 text-center sm:hidden">
                        Jun 18–24
                      </div>
                    </figure>
                  </div>
                )}
              </div>

              <div className="space-y-3 type-body text-muted-foreground">
                <p>Here is your daily cost trend for the last 7 days (Jun 18–24):</p>
                <ul className="list-disc space-y-2 pl-6 marker:text-foreground-subtle">
                  <li>
                    <strong className="text-foreground">Total spend:</strong> $2.63 over the week
                  </li>
                  <li>
                    <strong className="text-foreground">Daily average:</strong> $0.38
                  </li>
                  <li>
                    <strong className="text-foreground">Peak day:</strong> Jun 18 at $1.42, 54% of
                    the week&apos;s cost
                  </li>
                  <li>
                    <strong className="text-foreground">Quietest days:</strong> Jun 21–22 with no
                    Credit spend
                  </li>
                  <li>
                    <strong className="text-foreground">Trend:</strong> Spend peaked at the start of
                    the week, paused midweek, then resumed at a lower level.
                  </li>
                </ul>
                <p>
                  The Jun 18 spike is the main driver of weekly spend. Break down that day by model
                  to identify which usage drove the cost.
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="sticky bottom-4 mt-8">
        <Label htmlFor="ask-kilo-follow-up" className="sr-only">
          Ask a follow-up question
        </Label>
        <div className="relative">
          <Input
            id="ask-kilo-follow-up"
            value={question}
            onChange={event => setQuestion(event.target.value)}
            placeholder="Ask a follow-up about your spending..."
            className="bg-card h-12! rounded-xl pr-14 shadow-lg"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!question.trim()}
            aria-label="Ask Kilo"
            className="absolute top-1.5 right-1.5"
          >
            <Send className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </form>
    </section>
  );
}
