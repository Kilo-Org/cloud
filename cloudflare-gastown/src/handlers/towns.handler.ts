import type { Context } from 'hono';
import { z } from 'zod';
import { getGastownUserStub } from '../dos/GastownUser.do';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';

const TOWNS_LOG = '[towns.handler]';

const CreateTownBody = z.object({
  name: z.string().min(1).max(64),
});

const CreateRigBody = z.object({
  town_id: z.string().min(1),
  name: z.string().min(1).max(64),
  git_url: z.string().url(),
  default_branch: z.string().min(1).default('main'),
  kilocode_token: z.string().min(1).optional(),
  platform_integration_id: z.string().min(1).optional(),
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
    console.error(`${TOWNS_LOG} handleCreateRig: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${TOWNS_LOG} handleCreateRig: userId=${params.userId} town_id=${parsed.data.town_id} name=${parsed.data.name} git_url=${parsed.data.git_url} hasKilocodeToken=${!!parsed.data.kilocode_token}`
  );

  const townDO = getGastownUserStub(c.env, params.userId);
  const rig = await townDO.createRig(parsed.data);
  console.log(`${TOWNS_LOG} handleCreateRig: rig created id=${rig.id}, now configuring Rig DO`);

  // Configure the Town DO with rig metadata and register the rig.
  // If this fails, roll back the rig creation to avoid an orphaned record.
  try {
    const townDOStub = getTownDOStub(c.env, parsed.data.town_id);
    await townDOStub.configureRig({
      rigId: rig.id,
      townId: parsed.data.town_id,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
      userId: params.userId,
      kilocodeToken: parsed.data.kilocode_token,
    });
    await townDOStub.addRig({
      rigId: rig.id,
      name: parsed.data.name,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
    });
    console.log(`${TOWNS_LOG} handleCreateRig: Town DO configured and rig registered`);
  } catch (err) {
    console.error(
      `${TOWNS_LOG} handleCreateRig: Town DO configure FAILED for rig ${rig.id}, rolling back:`,
      err
    );
    await townDO.deleteRig(rig.id);
    return c.json(resError('Failed to configure rig'), 500);
  }

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

  // Destroy the Town DO (handles all rigs, agents, and mayor cleanup)
  try {
    const townDOStub = getTownDOStub(c.env, params.townId);
    await townDOStub.destroy();
    console.log(`${TOWNS_LOG} handleDeleteTown: Town DO destroyed for town ${params.townId}`);
  } catch (err) {
    console.error(`${TOWNS_LOG} handleDeleteTown: failed to destroy Town DO:`, err);
  }

  const deleted = await townDO.deleteTown(params.townId);
  if (!deleted) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}

export async function handleDeleteRig(
  c: Context<GastownEnv>,
  params: { userId: string; rigId: string }
) {
  const userDO = getGastownUserStub(c.env, params.userId);
  const rig = await userDO.getRigAsync(params.rigId);
  if (!rig) return c.json(resError('Rig not found'), 404);

  const deleted = await userDO.deleteRig(params.rigId);
  if (!deleted) return c.json(resError('Rig not found'), 404);

  // Remove the rig from the Town DO
  try {
    const townDOStub = getTownDOStub(c.env, rig.town_id);
    await townDOStub.removeRig(params.rigId);
  } catch (err) {
    console.error(`${TOWNS_LOG} handleDeleteRig: failed to remove rig from Town DO:`, err);
  }

  return c.json(resSuccess({ deleted: true }));
}
