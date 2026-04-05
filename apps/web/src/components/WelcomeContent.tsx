'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { YouTubeEmbed } from '@/components/YouTubeEmbed';
import { FIRST_TOPUP_BONUS_AMOUNT } from '@/lib/constants';
import { FirstTopup24for24CountdownTimer } from '@/components/payment/FirstTopup24for24CountdownTimer';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Check, Copy, Terminal } from 'lucide-react';
import type { EditorOption } from '@/lib/editorOptions';
import { EDITOR_OPTIONS } from '@/lib/editorOptions';

type WelcomeContentProps = {
  ideName: string;
  logoSrc: string | undefined;
  hasCredits: boolean;
  editor: EditorOption;
  isAuthenticated: boolean;
};

const CLI_COMMAND = 'npm install -g @kilocode/cli';

function CLIInstallCommand() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(CLI_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-background/50 border-border/50 flex items-center gap-3 rounded-md border p-4 font-mono text-sm md:text-xl">
      <span className="text-muted-foreground select-none">$</span>
      <code className="text-foreground flex-1 font-semibold">{CLI_COMMAND}</code>
      <Button
        onClick={handleCopy}
        size="sm"
        variant="outline"
        className="shrink-0"
        aria-label="Copy command"
      >
        {copied ? (
          <>
            <Check className="h-4 w-4" />
            <span className="hidden sm:inline">Copied!</span>
          </>
        ) : (
          <>
            <Copy className="h-4 w-4" />
            <span className="hidden sm:inline">Copy</span>
          </>
        )}
      </Button>
    </div>
  );
}

export default function WelcomeContent({
  ideName,
  logoSrc,
  editor,
  isAuthenticated,
}: WelcomeContentProps) {
  // Only show credit purchase options if authenticated and needs credits
  const welcomeMessage = 'Start immediately by using free models!';

  const isJetBrains = editor.scheme === 'jetbrains';
  const defaultTab = isJetBrains ? 'jetbrains' : 'vscode';

  return (
    <div className="container mx-auto flex max-w-4xl flex-col items-center gap-8">
      <h1 className="text-4xl font-bold sm:text-5xl">Your Kilo Code Account is Ready</h1>

      <p className="text-center align-middle text-lg">{welcomeMessage}</p>

      <div className="border-border w-full rounded-lg border">
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList className="border-border h-auto w-full flex-wrap justify-center gap-2 rounded-t-lg rounded-b-none border-b bg-transparent p-0">
            <TabsTrigger
              value="vscode"
              className="data-[state=active]:text-brand-primary data-[state=active]:border-brand-primary hover:text-foreground flex cursor-pointer items-center gap-2 rounded-none px-4 py-3 text-sm font-medium data-[state=active]:-mb-[1px] data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <Image src="/logos/vscode.svg" alt="VS Code" width={20} height={20} />
              <span>VS Code</span>
            </TabsTrigger>
            <TabsTrigger
              value="jetbrains"
              className="data-[state=active]:text-brand-primary data-[state=active]:border-brand-primary hover:text-foreground flex cursor-pointer items-center gap-2 rounded-none px-4 py-3 text-sm font-medium data-[state=active]:-mb-[1px] data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              {isJetBrains && logoSrc ? (
                <Image src={logoSrc} alt={ideName} width={20} height={20} />
              ) : (
                <Image src="/logos/idea.svg" alt="JetBrains" width={20} height={20} />
              )}
              <span>{isJetBrains ? ideName : 'JetBrains'}</span>
            </TabsTrigger>
            <TabsTrigger
              value="cli"
              className="data-[state=active]:text-brand-primary data-[state=active]:border-brand-primary hover:text-foreground flex cursor-pointer items-center gap-2 rounded-none px-4 py-3 text-sm font-medium data-[state=active]:-mb-[1px] data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <Terminal className="h-5 w-5" />
              <span>CLI</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="vscode" className="p-6">
            <div className="space-y-6">
              <div className="space-y-3">
                <h3 className="text-center text-xl font-semibold">VS Code</h3>
                <p className="text-muted-foreground text-center">
                  To install Kilo Code in VS Code, you need to have Visual Studio Code installed on
                  your computer.
                </p>
              </div>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <span className="text-brand-primary font-bold">1.</span>
                  <div>
                    <p className="font-medium">Install VS Code</p>
                    <p className="text-muted-foreground text-sm">
                      If you don&apos;t have VS Code installed yet,{' '}
                      <a
                        href="https://code.visualstudio.com/download"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-primary hover:underline"
                      >
                        download it here
                      </a>
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-brand-primary font-bold">2.</span>
                  <div>
                    <p className="font-medium">Install the extension</p>
                    <p className="text-muted-foreground text-sm">
                      Click the button below to install Kilo Code directly in VS Code
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex justify-center pt-2">
                <Button
                  asChild
                  className="flex h-14 w-full max-w-sm items-center justify-center rounded-xl bg-linear-to-r from-[#0078D4] to-[#106EBE] text-lg font-semibold text-white shadow transition-all duration-200 hover:scale-105 hover:from-[#1084E8] hover:to-[#0F7BD2] hover:shadow-xl focus:ring-4 focus:ring-blue-300 focus:ring-offset-2 focus:outline-none"
                >
                  <a
                    href={EDITOR_OPTIONS.find(e => e.source === 'vscode')?.extensionUrl}
                    className="inline-flex items-center gap-3"
                  >
                    <Image src="/logos/vscode.svg" alt="VS Code" width={28} height={28} />
                    Install in VS Code
                  </a>
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="jetbrains" className="p-6">
            {isJetBrains ? (
              <div className="space-y-6">
                <div className="space-y-3">
                  <h3 className="text-center text-xl font-semibold">{ideName}</h3>
                  <p className="text-muted-foreground text-center">
                    Continue using Kilo Code in {ideName}. The extension is already installed and
                    ready to use.
                  </p>
                </div>
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <span className="text-brand-primary font-bold">1.</span>
                    <div>
                      <p className="font-medium">Return to your editor</p>
                      <p className="text-muted-foreground text-sm">
                        Open {ideName} and use the Kilo Code panel to start coding with AI
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="text-brand-primary font-bold">2.</span>
                    <div>
                      <p className="font-medium">Start coding with AI</p>
                      <p className="text-muted-foreground text-sm">
                        Use the Kilo Code panel to chat with AI, generate code, and get help with
                        your projects
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex justify-center pt-2">
                  <Button
                    asChild
                    className="flex h-14 w-full max-w-sm items-center justify-center rounded-xl bg-linear-to-r from-[#FE315D] to-[#E91E63] text-lg font-semibold text-white shadow transition-all duration-200 hover:scale-105 hover:from-[#FF4570] hover:to-[#F02B72] hover:shadow-xl focus:ring-4 focus:ring-pink-300 focus:ring-offset-2 focus:outline-none"
                  >
                    <a
                      href="https://plugins.jetbrains.com/plugin/28350-kilo-code"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-3"
                    >
                      {logoSrc && <Image src={logoSrc} alt={ideName} width={28} height={28} />}
                      View on Marketplace
                    </a>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="space-y-3">
                  <h3 className="text-center text-xl font-semibold">JetBrains IDEs</h3>
                  <p className="text-muted-foreground text-center">
                    Kilo Code is available for all JetBrains IDEs including IntelliJ IDEA, WebStorm,
                    PyCharm, and more. To install Kilo Code in a JetBrains IDE, you need to have a
                    JetBrains IDE installed on your computer.
                  </p>
                </div>
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <span className="text-brand-primary font-bold">1.</span>
                    <div>
                      <p className="font-medium">Install a JetBrains IDE</p>
                      <p className="text-muted-foreground text-sm">
                        If you don&apos;t have a JetBrains IDE installed yet,{' '}
                        <a
                          href="https://www.jetbrains.com/ides/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-primary hover:underline"
                        >
                          choose and download one here
                        </a>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="text-brand-primary font-bold">2.</span>
                    <div>
                      <p className="font-medium">Install from IDE</p>
                      <p className="text-muted-foreground text-sm">
                        Open your JetBrains IDE → Settings → Plugins → Search for &quot;Kilo
                        Code&quot; → Install
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex justify-center pt-2">
                  <Button
                    asChild
                    className="flex h-14 w-full max-w-sm items-center justify-center rounded-xl bg-linear-to-r from-[#FE315D] to-[#E91E63] text-lg font-semibold text-white shadow transition-all duration-200 hover:scale-105 hover:from-[#FF4570] hover:to-[#F02B72] hover:shadow-xl focus:ring-4 focus:ring-pink-300 focus:ring-offset-2 focus:outline-none"
                  >
                    <a
                      href="https://plugins.jetbrains.com/plugin/28350-kilo-code"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-3"
                    >
                      <Image src="/logos/idea.svg" alt="JetBrains" width={28} height={28} />
                      View on Marketplace
                    </a>
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="cli" className="p-6">
            <div className="space-y-6">
              <div className="space-y-3">
                <h3 className="text-center text-xl font-semibold">CLI</h3>
                <p className="text-muted-foreground text-center">
                  Install Kilo Code CLI to access AI coding assistance directly from your terminal.
                </p>
              </div>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <span className="text-brand-primary font-bold">1.</span>
                  <div>
                    <p className="font-medium">Install Node.js</p>
                    <p className="text-muted-foreground text-sm">
                      If you don&apos;t have Node.js installed yet,{' '}
                      <a
                        href="https://nodejs.org/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-primary hover:underline"
                      >
                        download it here
                      </a>
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-brand-primary font-bold">2.</span>
                  <div>
                    <p className="font-medium">Install with npm</p>
                    <p className="text-muted-foreground text-sm">
                      Run the following command in your terminal:
                    </p>
                  </div>
                </div>
              </div>
              <CLIInstallCommand />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <div className="flex w-full flex-col items-center gap-2">
        <p className="text-muted-foreground text-sm">
          Get started faster: key concepts of Kilo Code
        </p>
        <div className="self-stretch overflow-hidden rounded-lg shadow-xl">
          <YouTubeEmbed
            videoId="WqDm6Yg1bu0"
            width="100%"
            height="auto"
            className="aspect-video w-full"
            title="Your first 14 minutes with Kilo Code"
          />
        </div>
      </div>
      <div className="text-center text-lg">
        {isAuthenticated ? (
          <>
            Or, go to your{' '}
            <Link href="/profile" className="font-semibold text-blue-400 hover:underline">
              profile
            </Link>
            , where you can top up your AI model credits,
            <br /> and get ${FIRST_TOPUP_BONUS_AMOUNT()} in bonus credits on your first top up.
            <div>
              <FirstTopup24for24CountdownTimer />
            </div>
          </>
        ) : (
          <>
            Or,{' '}
            <Link
              href="/users/sign_in?callbackPath=/profile"
              className="font-semibold text-blue-400 hover:underline"
            >
              sign in or sign up
            </Link>{' '}
            to buy credits, where you can top up your AI model credits,
            <br /> and get ${FIRST_TOPUP_BONUS_AMOUNT()} in bonus credits on your first top up.
            <div>
              <FirstTopup24for24CountdownTimer />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
