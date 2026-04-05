import type { Context } from 'hono';
import { z } from 'zod';
import { getGastownOrgStub } from '../dos/GastownOrg.do';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';

const ORG_TOWNS_LOG = '[org-towns.handler]';

const CreateOrgTownBody = z.object({
  name: z.string().min(1).max(64),
});

const CreateOrgRigBody = z.object({
  town_id: z.string().min(1),
  name: z.string().min(1).max(64),
  git_url: z.string().url(),
  default_branch: z.string().min(1).default('main'),
  platform_integration_id: z.string().min(1).optional(),
});

export async function handleCreateOrgTown(c: Context<GastownEnv>, params: { orgId: string }) {
  const parsed = CreateOrgTownBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const orgDO = getGastownOrgStub(c.env, params.orgId);
  const town = await orgDO.createTown({
    name: parsed.data.name,
    owner_org_id: params.orgId,
    created_by_user_id: userId,
  });

  // Initialize the TownDO config with org ownership metadata
  const townDOStub = getTownDOStub(c.env, town.id);
  await townDOStub.setTownId(town.id);
  await townDOStub.updateTownConfig({
    owner_type: 'org',
    owner_id: params.orgId,
    owner_user_id: userId,
    organization_id: params.orgId,
    created_by_user_id: userId,
  });

  return c.json(resSuccess(town), 201);
}

export async function handleListOrgTowns(c: Context<GastownEnv>, params: { orgId: string }) {
  const orgDO = getGastownOrgStub(c.env, params.orgId);
  const towns = await orgDO.listTowns();
  return c.json(resSuccess(towns));
}

export async function handleGetOrgTown(
  c: Context<GastownEnv>,
  params: { orgId: string; townId: string }
) {
  const orgDO = getGastownOrgStub(c.env, params.orgId);
  const town = await orgDO.getTownAsync(params.townId);
  if (!town) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess(town));
}

export async function handleCreateOrgRig(c: Context<GastownEnv>, params: { orgId: string }) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const parsed = CreateOrgRigBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${ORG_TOWNS_LOG} handleCreateOrgRig: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${ORG_TOWNS_LOG} handleCreateOrgRig: orgId=${params.orgId} town_id=${parsed.data.town_id} name=${parsed.data.name} git_url=${parsed.data.git_url}`
  );

  const orgDO = getGastownOrgStub(c.env, params.orgId);

  // Verify the town belongs to this org before creating the rig
  const town = await orgDO.getTownAsync(parsed.data.town_id);
  if (!town) return c.json(resError('Town not found in this org'), 404);

  const rig = await orgDO.createRig(parsed.data);
  console.log(
    `${ORG_TOWNS_LOG} handleCreateOrgRig: rig created id=${rig.id}, now configuring Town DO`
  );

  // Configure the Town DO with rig metadata and register the rig.
  // If this fails, roll back the rig creation to avoid an orphaned record.
  try {
    const townDOStub = getTownDOStub(c.env, parsed.data.town_id);
    await townDOStub.configureRig({
      rigId: rig.id,
      townId: parsed.data.town_id,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
      userId,
      // Never trust caller-supplied kilocode tokens for org rigs — the
      // town's existing token (minted by the owner) is used instead.
      kilocodeToken: undefined,
      platformIntegrationId: parsed.data.platform_integration_id,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
    await townDOStub.addRig({
      rigId: rig.id,
      name: parsed.data.name,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
    });
    console.log(`${ORG_TOWNS_LOG} handleCreateOrgRig: Town DO configured and rig registered`);
  } catch (err) {
    console.error(
      `${ORG_TOWNS_LOG} handleCreateOrgRig: Town DO configure FAILED for rig ${rig.id}, rolling back:`,
      err
    );
    await orgDO.deleteRig(rig.id);
    return c.json(resError('Failed to configure rig'), 500);
  }

  return c.json(resSuccess(rig), 201);
}

export async function handleListOrgRigs(
  c: Context<GastownEnv>,
  params: { orgId: string; townId: string }
) {
  const orgDO = getGastownOrgStub(c.env, params.orgId);
  const rigs = await orgDO.listRigs(params.townId);
  return c.json(resSuccess(rigs));
}

export async function handleGetOrgRig(
  c: Context<GastownEnv>,
  params: { orgId: string; rigId: string }
) {
  const orgDO = getGastownOrgStub(c.env, params.orgId);
  const rig = await orgDO.getRigAsync(params.rigId);
  if (!rig) return c.json(resError('Rig not found'), 404);
  return c.json(resSuccess(rig));
}

export async function handleDeleteOrgTown(
  c: Context<GastownEnv>,
  params: { orgId: string; townId: string }
) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Verify owner role via JWT claims (works in dev mode where orgAuthMiddleware is skipped)
  const memberships = c.get('kiloOrgMemberships') ?? [];
  const membership = memberships.find(m => m.orgId === params.orgId);
  if (!membership || membership.role !== 'owner') {
    return c.json(resError('Only org owners can delete towns'), 403);
  }

  const orgDO = getGastownOrgStub(c.env, params.orgId);

  // Verify the town belongs to this org BEFORE destroying anything
  const town = await orgDO.getTownAsync(params.townId);
  if (!town) return c.json(resError('Town not found'), 404);

  // Destroy the Town DO (handles all rigs, agents, and mayor cleanup)
  try {
    const townDOStub = getTownDOStub(c.env, params.townId);
    await townDOStub.destroy();
    console.log(
      `${ORG_TOWNS_LOG} handleDeleteOrgTown: Town DO destroyed for town ${params.townId}`
    );
  } catch (err) {
    console.error(`${ORG_TOWNS_LOG} handleDeleteOrgTown: failed to destroy Town DO:`, err);
  }

  const deleted = await orgDO.deleteTown(params.townId);
  if (!deleted) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}

export async function handleDeleteOrgRig(
  c: Context<GastownEnv>,
  params: { orgId: string; rigId: string }
) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Verify owner role via JWT claims (works in dev mode where orgAuthMiddleware is skipped)
  const memberships = c.get('kiloOrgMemberships') ?? [];
  const membership = memberships.find(m => m.orgId === params.orgId);
  if (!membership || membership.role !== 'owner') {
    return c.json(resError('Only org owners can delete rigs'), 403);
  }

  const orgDO = getGastownOrgStub(c.env, params.orgId);
  const rig = await orgDO.getRigAsync(params.rigId);
  if (!rig) return c.json(resError('Rig not found'), 404);

  const deleted = await orgDO.deleteRig(params.rigId);
  if (!deleted) return c.json(resError('Rig not found'), 404);

  // Remove the rig from the Town DO
  try {
    const townDOStub = getTownDOStub(c.env, rig.town_id);
    await townDOStub.removeRig(params.rigId);
  } catch (err) {
    console.error(`${ORG_TOWNS_LOG} handleDeleteOrgRig: failed to remove rig from Town DO:`, err);
  }

  return c.json(resSuccess({ deleted: true }));
}
