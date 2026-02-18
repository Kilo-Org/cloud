import type { Context } from 'hono';
import { z } from 'zod';
import { getGastownUserStub } from '../dos/GastownUser.do';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';

const CreateTownBody = z.object({
  name: z.string().min(1).max(64),
});

const CreateRigBody = z.object({
  town_id: z.string().min(1),
  name: z.string().min(1).max(64),
  git_url: z.string().url(),
  default_branch: z.string().min(1).default('main'),
});

/**
 * Town DO instances are keyed by owner_user_id (the :userId path param)
 * so all of a user's towns live in a single DO instance.
 */

export async function handleCreateTown(c: Context<GastownEnv>, params: { userId: string }) {
  const parsed = CreateTownBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const townDO = getGastownUserStub(c.env, params.userId);
  const town = await townDO.createTown({ name: parsed.data.name, owner_user_id: params.userId });
  return c.json(resSuccess(town), 201);
}

export async function handleListTowns(c: Context<GastownEnv>, params: { userId: string }) {
  const townDO = getGastownUserStub(c.env, params.userId);
  const towns = await townDO.listTowns();
  return c.json(resSuccess(towns));
}

export async function handleGetTown(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const townDO = getGastownUserStub(c.env, params.userId);
  const town = await townDO.getTownAsync(params.townId);
  if (!town) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess(town));
}

export async function handleCreateRig(c: Context<GastownEnv>, params: { userId: string }) {
  const parsed = CreateRigBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const townDO = getGastownUserStub(c.env, params.userId);
  const rig = await townDO.createRig(parsed.data);

  // Configure the Rig DO with its metadata so it can dispatch work to the container
  const rigDO = getRigDOStub(c.env, rig.id);
  await rigDO.configureRig({
    townId: parsed.data.town_id,
    gitUrl: parsed.data.git_url,
    defaultBranch: parsed.data.default_branch,
    userId: params.userId,
  });

  return c.json(resSuccess(rig), 201);
}

export async function handleGetRig(
  c: Context<GastownEnv>,
  params: { userId: string; rigId: string }
) {
  const townDO = getGastownUserStub(c.env, params.userId);
  const rig = await townDO.getRigAsync(params.rigId);
  if (!rig) return c.json(resError('Rig not found'), 404);
  return c.json(resSuccess(rig));
}

export async function handleListRigs(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const townDO = getGastownUserStub(c.env, params.userId);
  const rigs = await townDO.listRigs(params.townId);
  return c.json(resSuccess(rigs));
}

export async function handleDeleteTown(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const townDO = getGastownUserStub(c.env, params.userId);
  const deleted = await townDO.deleteTown(params.townId);
  if (!deleted) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}

export async function handleDeleteRig(
  c: Context<GastownEnv>,
  params: { userId: string; rigId: string }
) {
  const townDO = getGastownUserStub(c.env, params.userId);
  const deleted = await townDO.deleteRig(params.rigId);
  if (!deleted) return c.json(resError('Rig not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}
