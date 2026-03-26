'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Download, Users, CreditCard } from 'lucide-react';
import Link from 'next/link';

type OrganizationWelcomeCardsProps = {
  onInviteMemberClick: () => void;
  onBuyCreditsClick: () => void;
};

export function OrganizationWelcomeCards({
  onInviteMemberClick,
  onBuyCreditsClick,
}: OrganizationWelcomeCardsProps) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-foreground mb-2 text-3xl font-bold">
          You've created an account for your organization
        </h2>
        <p className="text-muted-foreground">
          With Kilo Teams you get powerful collaboration features and insights on top of our open
          source coding agent.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {/* Start Using It Now Card - Hidden on mobile */}
        <Link href="https://kilo.ai/install" className="hidden md:block">
          <Card className="hover:border-primary/20 h-full transition-shadow duration-200 hover:shadow-md">
            <CardContent className="flex h-full flex-col p-6 text-center">
              <div className="mb-2 flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-lg">
                  <Download className="text-primary h-8 w-8" />
                </div>
              </div>
              <h3 className="mb-2 text-lg font-semibold">I want to try it out first</h3>
              <p className="text-muted-foreground mb-6 flex-grow text-sm">
                Download and install Kilo Code to start using AI-powered development tools
              </p>
              <div className="focus-visible:ring-ring border-input bg-background relative inline-flex h-9 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-md border px-4 py-2 text-sm font-medium whitespace-nowrap shadow-sm transition-all hover:border-blue-400 hover:bg-gray-900 hover:text-blue-300 hover:shadow-md focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0">
                Install extension
              </div>
            </CardContent>
          </Card>
        </Link>

        {/* Invite Users Card */}
        <Card
          className="hover:border-primary/20 h-full cursor-pointer transition-shadow duration-200 hover:shadow-md"
          onClick={onInviteMemberClick}
        >
          <CardContent className="flex h-full flex-col p-6 text-center">
            <div className="mb-2 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-lg">
                <Users className="text-primary h-8 w-8" />
              </div>
            </div>
            <h3 className="mb-2 text-lg font-semibold">I'm ready to sign up my team</h3>
            <p className="text-muted-foreground mb-6 flex-grow text-sm">
              Invite your team members to collaborate
            </p>
            <div className="focus-visible:ring-ring border-input bg-background relative inline-flex h-9 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-md border px-4 py-2 text-sm font-medium whitespace-nowrap shadow-sm transition-all hover:border-blue-400 hover:bg-gray-900 hover:text-blue-300 hover:shadow-md focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0">
              Invite member
            </div>
          </CardContent>
        </Card>

        {/* Buy Credits Card */}
        <Card
          className="hover:border-primary/20 h-full cursor-pointer transition-shadow duration-200 hover:shadow-md"
          onClick={onBuyCreditsClick}
        >
          <CardContent className="flex h-full flex-col p-6 text-center">
            <div className="mb-2 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-lg">
                <CreditCard className="text-primary h-8 w-8" />
              </div>
            </div>
            <h3 className="mb-2 text-lg font-semibold">I want to buy AI usage credits</h3>
            <p className="text-muted-foreground mb-6 flex-grow text-sm">
              Purchase credits to power your AI development workflow
            </p>
            <div className="focus-visible:ring-ring border-input bg-background relative inline-flex h-9 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-md border px-4 py-2 text-sm font-medium whitespace-nowrap shadow-sm transition-all hover:border-blue-400 hover:bg-gray-900 hover:text-blue-300 hover:shadow-md focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0">
              Buy credits
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
