import jwt from 'jsonwebtoken';

type ImageMCPTokenClaims = {
  src_bucket: string;
  src_prefix: string;
  dst_bucket: string;
  dst_prefix: string;
  project_id: string;
  user_id: string;
};

function validateToken(authHeader: string | null, secret: string): ImageMCPTokenClaims {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);

  const payload = jwt.verify(token, secret, {
    algorithms: ['HS256'],
  });

  if (typeof payload === 'string') {
    throw new Error('Invalid token payload');
  }

  const { src_bucket, src_prefix, dst_bucket, dst_prefix, project_id, user_id } = payload;

  if (
    typeof src_bucket !== 'string' ||
    typeof src_prefix !== 'string' ||
    typeof dst_bucket !== 'string' ||
    typeof dst_prefix !== 'string' ||
    typeof project_id !== 'string' ||
    typeof user_id !== 'string'
  ) {
    throw new Error('Invalid token claims: missing required fields');
  }

  return { src_bucket, src_prefix, dst_bucket, dst_prefix, project_id, user_id };
}

export { validateToken, type ImageMCPTokenClaims };
