import 'server-only';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { app_reported_messages } from '@kilocode/db/schema';
import { generateMessageSignature } from '@/lib/app-reported-messages/messageSignature';
import * as z from 'zod';

const CreateReportInputSchema = z.object({
  message: z.looseObject({}),
  cli_session_id: z.uuid().nullable(),
  mode: z.string().nullable(),
  model: z.string().nullable(),
  report_type: z.enum(['unparsed', 'unstyled']),
});

export const appReportedMessagesRouter = createTRPCRouter({
  createReport: baseProcedure.input(CreateReportInputSchema).mutation(async ({ input }) => {
    const signature = generateMessageSignature(input.message);
    if (typeof signature !== 'object' || signature === null || Array.isArray(signature)) {
      throw new Error('Expected signature to be a JSON object');
    }

    const [inserted] = await db
      .insert(app_reported_messages)
      .values({
        ...input,
        signature,
      })
      .returning({ report_id: app_reported_messages.report_id });

    return inserted;
  }),
});
