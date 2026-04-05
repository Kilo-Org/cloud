import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

export const debugRouter = createTRPCRouter({
  badInputError: adminProcedure.input(z.string().min(2).max(100)).query(async opts => {
    return `you sent: ${opts.input}`;
  }),
  unhandledError: adminProcedure.query(async () => {
    throw new Error('This is a non-input related error');
  }),
  handledTrpcError: adminProcedure.query(async () => {
    throw new TRPCError({ code: 'CONFLICT', message: 'I like tacos' });
  }),
  badInputObjectError: adminProcedure
    .input(
      z.object({
        name: z.string().min(2).max(100),
        age: z.number().min(0).max(150),
      })
    )
    .query(async opts => {
      return `you sent: ${opts.input.name} who is ${opts.input.age} years old`;
    }),
});
