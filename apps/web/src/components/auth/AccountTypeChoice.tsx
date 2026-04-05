'use client';

import { KiloCardLayout } from '@/components/KiloCardLayout';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowRight, Users } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';

export function AccountTypeChoice() {
  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3 }}
    >
      <KiloCardLayout title="Get started with Kilo" className="max-w-xl">
        <div className="space-y-8">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Link href="/get-started/personal" className="block">
              <div className="group/card ring-border cursor-pointer rounded-lg p-6 ring-2 ring-inset">
                <CardHeader className="gap-1 p-0 pb-4">
                  <CardTitle className="text-xl font-bold text-white underline">
                    Individual
                  </CardTitle>
                  <CardDescription className="text-base text-white/80 italic">
                    For individual developers
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 p-0 pt-4">
                  <ul className="space-y-2 text-white">
                    <li className="flex items-start gap-2">
                      <span className="text-lg leading-6">✓</span>
                      <span>Pay only for what you use</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-lg leading-6">✓</span>
                      <span>Access 500+ AI models</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-lg leading-6">✓</span>
                      <span>Individual usage analytics</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-lg leading-6">✓</span>
                      <span>No usage limits</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-lg leading-6">✓</span>
                      <span>Use Kilo in IDEs (VS Code/JetBrains), CLI, Cloud, and App Builder</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-lg leading-6">✓</span>
                      <span>Unlock all Kilo features to code, review and deploy</span>
                    </li>
                  </ul>
                  <Button
                    variant="primary"
                    className="text-foreground w-full transition-all duration-200 hover:shadow-lg"
                    size="lg"
                  >
                    Start here
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </CardContent>
              </div>
            </Link>
          </motion.div>

          <div>
            <Link
              href="/organizations/new"
              className="ring-border hover:ring-muted-foreground group flex items-center gap-3 rounded-lg p-3 ring-1 transition-all hover:bg-white/5"
            >
              <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                <Users className="text-muted-foreground h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">Create a Team Workspace</p>
                <p className="text-muted-foreground text-xs">
                  Collaborate, track usage, and manage access controls
                </p>
              </div>
            </Link>
          </div>
        </div>
      </KiloCardLayout>
    </motion.div>
  );
}
