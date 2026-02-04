import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { cli_sessions_v2, kilocode_users } from '@/db/schema';
import { notFound } from 'next/navigation';
import { validate as isValidUUID } from 'uuid';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { CopyableCommand } from '@/components/CopyableCommand';
import { APP_URL } from '@/lib/constants';
import { OpenInCliButton } from '@/app/share/[shareId]/open-in-cli-button';

export const revalidate = 86400;

export default async function SharedSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  // Validate sessionId is a valid UUID before querying the database
  if (!isValidUUID(sessionId)) {
    return notFound();
  }

  const sessionResult = await db
    .select({
      ownerName: kilocode_users.google_user_name,
      title: cli_sessions_v2.title,
    })
    .from(cli_sessions_v2)
    .leftJoin(kilocode_users, eq(cli_sessions_v2.kilo_user_id, kilocode_users.id))
    .where(eq(cli_sessions_v2.public_id, sessionId))
    .limit(1);

  if (sessionResult.length === 0) {
    return notFound();
  }

  const session = sessionResult[0];
  const shareUrl = `${APP_URL}/s/${sessionId}`;
  const importCommand = `kilo import ${shareUrl}`;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mx-auto flex flex-col items-center gap-12">
        <AnimatedLogo />

        <div className="flex w-full flex-col items-center gap-8 text-center">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <h1 className="text-4xl font-bold tracking-tight">
                {session.ownerName ?? 'Someone'} shared a session
              </h1>
              {session.title && (
                <div className="text-muted-foreground text-sm">{session.title}</div>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <div className="text-muted-foreground text-sm">Import this session in the CLI:</div>
              <div className="flex justify-center">
                <OpenInCliButton command={importCommand} />
              </div>
              <CopyableCommand
                command={importCommand}
                className="bg-muted rounded-md px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
