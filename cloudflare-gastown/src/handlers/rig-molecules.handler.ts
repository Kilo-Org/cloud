import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getTownId } from '../middleware/auth.middleware';
import type { GastownEnv } from '../gastown.worker';

export async function handleGetMoleculeCurrentStep(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const step = await town.getMoleculeCurrentStep(params.agentId);
  if (!step) return c.json(resError('No active molecule for this agent'), 404);
  return c.json(resSuccess(step));
}

const AdvanceMoleculeBody = z.object({
  summary: z.string().min(1).max(5000),
});

export async function handleAdvanceMoleculeStep(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const body = await parseJsonBody(c);
  const parsed = AdvanceMoleculeBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const result = await town.advanceMoleculeStep(params.agentId, parsed.data.summary);
  return c.json(resSuccess(result));
}

const CreateMoleculeBody = z.object({
  bead_id: z.string().min(1),
  formula: z.object({
    steps: z
      .array(
        z.object({
          title: z.string().min(1),
          instructions: z.string().min(1),
        })
      )
      .min(1),
  }),
});

export async function handleCreateMolecule(c: Context<GastownEnv>, params: { rigId: string }) {
  const body = await parseJsonBody(c);
  const parsed = CreateMoleculeBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const mol = await town.createMolecule(parsed.data.bead_id, parsed.data.formula);
  return c.json(resSuccess(mol), 201);
}
