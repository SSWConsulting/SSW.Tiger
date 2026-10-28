import * as oidc from 'openid-client';
import { TIGER_API_SCOPE } from './config.js';

export class ReauthenticationRequired extends Error {}

function tokenData(tokens, previousRefreshToken) {
  if (!tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0
    || !(tokens.refresh_token || previousRefreshToken)) throw new ReauthenticationRequired('Missing renewable tokens');
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || previousRefreshToken,
    accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

export async function createAuth(config, options = {}) {
  const client = await oidc.discovery(new URL(config.issuer), config.clientId,
    { token_endpoint_auth_method: 'none' }, oidc.None(), options);
  oidc.enableNonRepudiationChecks(client);
  return {
    async begin() {
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: config.redirectUri, response_type: 'code', scope: `openid profile email offline_access ${TIGER_API_SCOPE}`,
        code_challenge: challenge, code_challenge_method: 'S256', state, nonce,
      });
      return { url: url.href, transaction: { verifier, state, nonce } };
    },
    async finish(url, transaction) {
      const tokens = await oidc.authorizationCodeGrant(client, url, {
        pkceCodeVerifier: transaction.verifier, expectedState: transaction.state,
        expectedNonce: transaction.nonce, idTokenExpected: true,
      });
      return { claims: tokens.claims(), idToken: tokens.id_token, ...tokenData(tokens) };
    },
    async refresh(session) {
      let tokens;
      try { tokens = await oidc.refreshTokenGrant(client, session.refreshToken); }
      catch (error) {
        if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant') {
          throw new ReauthenticationRequired('Refresh authorization expired');
        }
        throw error;
      }
      const claims = tokens.id_token ? tokens.claims() : undefined;
      if (claims && (claims.sub !== session.user.sub || claims.iss !== config.issuer)) {
        throw new ReauthenticationRequired('Refresh identity changed');
      }
      return { ...tokenData(tokens, session.refreshToken), ...(tokens.id_token ? { idToken: tokens.id_token, claims } : {}) };
    },
    async revoke(refreshToken) {
      await oidc.tokenRevocation(client, refreshToken, { token_type_hint: 'refresh_token' });
    },
    logout(idToken) {
      if (!client.serverMetadata().end_session_endpoint) return `${config.origin}/`;
      return oidc.buildEndSessionUrl(client, {
        id_token_hint: idToken, post_logout_redirect_uri: `${config.origin}/`,
      }).href;
    },
  };
}
