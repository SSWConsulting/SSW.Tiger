import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

export class ApiAuthError extends Error {
  constructor(message = 'invalid_token', status = 401) { super(message); this.status = status; }
}

export function createApiAuth(config, fetcher = fetch) {
  let pendingKeys;
  const keys = () => pendingKeys ||= (async () => {
    const response = await fetcher(`${config.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('IdentityServer discovery unavailable');
    const metadata = await response.json();
    if (metadata.issuer !== config.issuer || new URL(metadata.jwks_uri).protocol !== 'https:') throw new Error('Invalid IdentityServer discovery');
    return createRemoteJWKSet(new URL(metadata.jwks_uri), { [customFetch]: fetcher, timeoutDuration: 5000 });
  })().catch(error => { pendingKeys = undefined; throw error; });

  return {
    async verify(authorization, { allowCallback = false } = {}) {
      const match = /^Bearer ([^\s,]+)$/i.exec(authorization || '');
      if (!match || match[1].length > 16384) throw new ApiAuthError();
      const keySet = await keys();
      let payload;
      try {
        ({ payload } = await jwtVerify(match[1], keySet, {
          issuer: config.issuer, audience: config.apiAudience, algorithms: ['RS256'],
          requiredClaims: ['sub', 'iat', 'exp'], clockTolerance: 5,
        }));
      } catch { throw new ApiAuthError(); }
      if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 || payload.client_id !== config.clientId) throw new ApiAuthError();
      if (typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 5 || payload.exp <= payload.iat) throw new ApiAuthError();
      const scopes = Array.isArray(payload.scope) ? payload.scope : typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (!scopes.includes(config.apiScope)) {
        // IdentityServer internally signs its user callbacks without a scope claim.
        if (!allowCallback || payload.scope !== undefined || payload.exp <= payload.iat || payload.exp - payload.iat > 300) {
          throw new ApiAuthError('insufficient_scope', 403);
        }
      }
      return payload;
    },
  };
}
