import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import type { GastownEnv } from '../gastown.worker';
import { resError, resSuccess } from '../util/res.util';
import { authorizeTown, TownAuthorizationUnavailableError } from '../util/town-authorization.util';

export async function handleReauthorizeTownRuntime(
  c: Context<GastownEnv>,
  params: { townId: string }
) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);
  const town = getTownDOStub(c.env, params.townId);
  const identity = await town.getPrivateTownIdentity();
  if (!identity) return c.json(resError('Town requires recreation'), 409);
  let modernAuthorization;
  if (identity.runtimeMode === 'modern') {
    try {
      modernAuthorization = await authorizeTown(
        c.env,
        identity,
        userId,
        c.get('kiloApiTokenPepper')
      );
      if (!modernAuthorization) return c.json(resError('Forbidden'), 403);
      if (
        identity.ownerType === 'org' &&
        (modernAuthorization.type !== 'org' || modernAuthorization.role !== 'owner')
      ) {
        return c.json(resError('Forbidden'), 403);
      }
    } catch (error) {
      if (error instanceof TownAuthorizationUnavailableError) {
        return c.json(resError('Authorization unavailable'), 503);
      }
      throw error;
    }
  }
  if (identity.ownerType === 'user' && identity.ownerUserId !== userId) {
    return c.json(resError('Forbidden'), 403);
  }
  if (identity.ownerType === 'org' && identity.runtimeMode !== 'modern') {
    const membership = (c.get('kiloOrgMemberships') ?? []).find(
      value => value.orgId === identity.organizationId
    );
    if (!membership || membership.role !== 'owner') {
      return c.json(resError('Forbidden'), 403);
    }
  }
  const authorized = await town.reauthorizeRuntime(
    c.get('kiloControlToken'),
    userId,
    identity.organizationId
  );
  if (!authorized) return c.json(resError('Town runtime cannot be reauthorized'), 409);
  return c.json(resSuccess({ reauthorized: true }));
}
