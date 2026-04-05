'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { PageContainer } from '@/components/layouts/PageContainer';

export default function TopUpThankYouPage() {
  return (
    <PageContainer>
      <div className="flex min-h-screen flex-col items-center justify-center">
        <Card className="w-full max-w-2xl border-green-900 bg-green-950/30">
          <CardContent className="p-8">
            <div className="flex flex-col gap-6">
              <div className="space-y-2">
                <p className="text-xl font-medium text-green-100">Thank you!</p>
                <h1 className="text-4xl font-bold text-green-100">
                  Your credits have been added to your balance.
                </h1>
              </div>

              <div className="space-y-4 text-green-200">
                <p>
                  <span className="mr-2">→</span>
                  <strong>Use them in all popular IDEs</strong> (VS Code/JetBrains), CLI, Cloud, and
                  App Builder
                </p>
                <p>
                  <span className="mr-2">→</span>
                  <strong>Access 500+ AI models</strong>, including Claude Sonnet 4.6, GPT-5.4,
                  Gemini 3.1, and hundreds more
                </p>
              </div>

              <div className="flex gap-4 pt-4">
                <Button asChild variant="primary" className="flex-1">
                  <Link href="/credits">View balance</Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="flex-1 border-green-700 text-green-100 hover:bg-green-900/50"
                >
                  <Link href="/credits">Configure auto top-up</Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
