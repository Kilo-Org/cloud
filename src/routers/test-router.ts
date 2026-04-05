import { adminProcedure, baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';

export const testRouter = createTRPCRouter({
  hello: baseProcedure
    .input(
      z
        .object({
          text: z.string(),
        })
        .optional()
        .default({ text: 'world' })
    )
    .query(async opts => {
      const { user } = opts.ctx;
      return {
        greeting: `hello ${opts.input.text} from user ${user.id}`,
      };
    }),

  adminHello: adminProcedure.query(async () => {
    return {
      message: 'hello world',
    };
  }),
});
