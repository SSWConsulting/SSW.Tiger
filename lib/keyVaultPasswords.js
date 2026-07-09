const { sanitizeId } = require("./sanitize");

let _client = null;

function getSecretClient() {
  if (_client) return _client;

  const keyVaultUrl = process.env.KEY_VAULT_URL;
  if (!keyVaultUrl) {
    throw new Error("KEY_VAULT_URL is required for dashboard password storage");
  }

  let SecretClient;
  let DefaultAzureCredential;
  try {
    ({ SecretClient } = require("@azure/keyvault-secrets"));
    ({ DefaultAzureCredential } = require("@azure/identity"));
  } catch (err) {
    throw new Error(
      "Missing Azure Key Vault dependencies. Install @azure/keyvault-secrets and @azure/identity.",
    );
  }

  _client = new SecretClient(keyVaultUrl, new DefaultAzureCredential());
  return _client;
}

function buildMeetingPasswordSecretName(projectName, meetingId) {
  const project = sanitizeId(projectName) || "general";
  const meeting = sanitizeId(meetingId);
  return `tiger-${project}-${meeting}-password`.substring(0, 127);
}

async function setMeetingPasswordSecret({ projectName, meetingId, password }) {
  const secretName = buildMeetingPasswordSecretName(projectName, meetingId);
  const client = getSecretClient();
  await client.setSecret(secretName, password, {
    contentType: "text/plain",
    tags: {
      app: "tiger",
      projectName: sanitizeId(projectName) || "general",
      meetingId: sanitizeId(meetingId),
    },
  });
  return secretName;
}

async function getMeetingPasswordSecret(secretName) {
  const client = getSecretClient();
  const result = await client.getSecret(secretName);
  return result.value;
}

module.exports = {
  buildMeetingPasswordSecretName,
  setMeetingPasswordSecret,
  getMeetingPasswordSecret,
};
