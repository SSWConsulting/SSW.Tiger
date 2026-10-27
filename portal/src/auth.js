import * as oidc from 'openid-client';

export async function createAuth(config, options = {}) {
  const client = await oidc.discovery(new URL(config.issuer), config.clientId,
    config.clientSecret, oidc.ClientSecretPost(config.clientSecret), options);
  oidc.enableNonRepudiationChecks(client);
  return {
    async begin() {
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid profile email',
        code_challenge: challenge, code_challenge_method: 'S256', state, nonce,
      });
      return { url: url.href, transaction: { verifier, state, nonce } };
    },
    async finish(url, transaction) {
      const tokens = await oidc.authorizationCodeGrant(client, url, {
        pkceCodeVerifier: transaction.verifier, expectedState: transaction.state,
        expectedNonce: transaction.nonce, idTokenExpected: true,
      });
      return { claims: tokens.claims(), idToken: tokens.id_token };
    },
    logout(idToken) {
      if (!client.serverMetadata().end_session_endpoint) return `${config.origin}/signed-out`;
      return oidc.buildEndSessionUrl(client, {
        id_token_hint: idToken, post_logout_redirect_uri: `${config.origin}/signed-out`,
      }).href;
    },
  };
}
