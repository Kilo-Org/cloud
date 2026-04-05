'use client';

import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Cloud, Download } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import KiloCrabIcon from '@/components/KiloCrabIcon';

type WelcomeContentProps = {
  isAuthenticated: boolean;
};

export default function WelcomeContent({ isAuthenticated }: WelcomeContentProps) {
  const cloudHref = isAuthenticated
    ? '/integrations/github'
    : '/users/sign_in?callbackPath=/integrations/github';
  const clawHref = isAuthenticated ? '/claw' : '/users/sign_in?callbackPath=/claw';
  const profileHref = isAuthenticated ? '/profile' : '/users/sign_in?callbackPath=/profile';

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3 }}
    >
      <CardContent className="space-y-4 p-4 pt-4">
        <div className="space-y-5">
          <h1 className="text-center text-2xl font-bold">Kilo works where you work</h1>

          <div className="grid gap-3 md:grid-cols-3">
            <motion.div
              whileHover={{ scale: 1.02, y: -4 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            >
              <Link
                className="group/card ring-border bg-card hover:ring-brand-primary hover:shadow-brand-primary/10 flex h-full cursor-pointer flex-col rounded-none ring-2 transition-all duration-300 ring-inset hover:shadow-xl"
                href="/welcome"
              >
                <CardHeader className="gap-1.5 p-4 pb-2 text-center">
                  <div className="bg-brand-primary/10 group-hover/card:bg-brand-primary/20 mx-auto flex h-12 w-12 items-center justify-center rounded-full transition-all duration-300">
                    <Download className="text-brand-primary h-8 w-8 transition-transform duration-300 group-hover/card:scale-110" />
                  </div>
                  <CardTitle className="text-xl font-bold tracking-tight">Install Kilo</CardTitle>
                  <CardDescription className="text-muted-foreground text-sm text-balance">
                    Use in VS Code, JetBrains, or directly from your terminal with the CLI.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-end p-4 pt-0">
                  <Button
                    className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary mt-2 w-full text-black hover:bg-black hover:ring-2"
                    size="lg"
                  >
                    Install Kilo
                  </Button>
                </CardContent>
              </Link>
            </motion.div>

            <motion.div
              whileHover={{ scale: 1.02, y: -4 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            >
              <Link
                className="group/card ring-border bg-card hover:ring-brand-primary hover:shadow-brand-primary/10 flex h-full cursor-pointer flex-col rounded-none ring-2 transition-all duration-300 ring-inset hover:shadow-xl"
                href={cloudHref}
              >
                <CardHeader className="gap-1.5 p-4 pb-2 text-center">
                  <div className="bg-brand-primary/10 group-hover/card:bg-brand-primary/20 mx-auto flex h-12 w-12 items-center justify-center rounded-full transition-all duration-300">
                    <Cloud className="text-brand-primary h-8 w-8 transition-transform duration-300 group-hover/card:scale-110" />
                  </div>
                  <CardTitle className="text-xl font-bold tracking-tight">Cloud</CardTitle>
                  <CardDescription className="text-muted-foreground text-sm text-balance">
                    Run Kilo from any device, no local machine required.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-end p-4 pt-0">
                  <Button
                    className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary mt-2 w-full text-black hover:bg-black hover:ring-2"
                    size="lg"
                  >
                    Connect GitHub Repo
                  </Button>
                </CardContent>
              </Link>
            </motion.div>

            <motion.div
              whileHover={{ scale: 1.02, y: -4 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            >
              <Link
                className="group/card ring-border bg-card hover:ring-brand-primary hover:shadow-brand-primary/10 flex h-full cursor-pointer flex-col rounded-none ring-2 transition-all duration-300 ring-inset hover:shadow-xl"
                href={clawHref}
              >
                <CardHeader className="gap-1.5 p-4 pb-2 text-center">
                  <div className="bg-brand-primary/10 group-hover/card:bg-brand-primary/20 mx-auto flex h-12 w-12 items-center justify-center rounded-full transition-all duration-300">
                    <KiloCrabIcon className="text-brand-primary h-8 w-8 transition-transform duration-300 group-hover/card:scale-110" />
                  </div>
                  <CardTitle className="text-xl font-bold tracking-tight">KiloClaw</CardTitle>
                  <CardDescription className="text-muted-foreground text-sm text-balance">
                    Your own AI assistant, managed and hosted in the cloud.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-end p-4 pt-0">
                  <Button
                    className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary mt-2 w-full text-black hover:bg-black hover:ring-2"
                    size="lg"
                  >
                    Try KiloClaw
                  </Button>
                </CardContent>
              </Link>
            </motion.div>
          </div>

          <div className="text-center">
            <p className="text-muted-foreground text-sm">
              {isAuthenticated ? (
                <>
                  Or jump to{' '}
                  <Link href="/profile" className="text-brand-primary underline">
                    your profile
                  </Link>
                  , where you&apos;ll find all these options.
                </>
              ) : (
                <>
                  Or{' '}
                  <Link href={profileHref} className="text-brand-primary underline">
                    sign in or sign up
                  </Link>{' '}
                  to access your profile and all these options.
                </>
              )}
            </p>
          </div>
        </div>
      </CardContent>
    </motion.div>
  );
}
