function jsonError(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}

export function invalidPathResponse() {
  return jsonError(
    {
      error: 'Invalid path',
      message: 'This endpoint only accepts the path `/chat/completions`.',
    },
    400
  );
}

export function invalidRequestResponse() {
  return jsonError(
    {
      error: 'Invalid request',
      message: 'Could not parse request body. Please ensure it is valid JSON.',
    },
    400
  );
}

export function temporarilyUnavailableResponse() {
  return jsonError(
    {
      error: 'Service Unavailable',
      message: 'The service is temporarily unavailable. Please try again later.',
    },
    503
  );
}

export function rateLimitExceededResponse() {
  return jsonError(
    {
      error: 'Rate limit exceeded',
      message: 'Free model usage limit reached. Please try again later or upgrade to a paid model.',
    },
    429
  );
}

export function paidModelAuthRequiredResponse() {
  return jsonError(
    {
      error: {
        code: 'PAID_MODEL_AUTH_REQUIRED',
        message: 'You need to sign in to use this model.',
      },
    },
    401
  );
}

export function promotionLimitReachedResponse() {
  return jsonError(
    {
      error: {
        code: 'PROMOTION_MODEL_LIMIT_REACHED',
        message:
          'Sign up for free to continue and explore 500 other models. ' +
          'Takes 2 minutes, no credit card required. Or come back later.',
      },
    },
    401
  );
}

export function usageLimitExceededResponse(params: {
  title: string;
  message: string;
  balance?: number;
  buyCreditsUrl: string;
}) {
  return jsonError(
    {
      error: {
        title: params.title,
        message: params.message,
        balance: params.balance,
        buyCreditsUrl: params.buyCreditsUrl,
      },
    },
    402
  );
}

export function dataCollectionRequiredResponse() {
  const error =
    'Data collection is required for this model. Please enable data collection to use this model or choose another model.';
  return jsonError({ error, message: error }, 400);
}

export function alphaPeriodEndedResponse() {
  const error = 'The alpha period for this model has ended.';
  return jsonError({ error, message: error }, 404);
}

export function modelNotAllowedResponse() {
  return jsonError(
    {
      error: 'Model not allowed for your team.',
      message: 'The requested model is not allowed for your team.',
    },
    404
  );
}

export function modelDoesNotExistResponse() {
  return jsonError(
    {
      error: 'Model not found',
      message: 'The requested model could not be found.',
    },
    404
  );
}

export function ipRequiredResponse() {
  return jsonError({ error: 'Unable to determine client IP' }, 400);
}

export function getOutputHeaders(response: Response): Headers {
  const outputHeaders = new Headers();
  for (const headerKey of ['date', 'content-type', 'request-id']) {
    const value = response.headers.get(headerKey);
    if (value) outputHeaders.set(headerKey, value);
  }
  outputHeaders.set('Content-Encoding', 'identity');
  return outputHeaders;
}

export function wrapResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: getOutputHeaders(response),
  });
}
