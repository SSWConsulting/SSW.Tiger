const crypto = require("crypto");

let _client = null;
const DEFAULT_PASSWORD_ENCRYPTION_KEY_SECRET_NAME =
  "tiger-password-encryption-key";

function getSecretClient() {
  if (_client) return _client;

  const keyVaultUrl = process.env.KEY_VAULT_URL;
  if (!keyVaultUrl) {
    throw new Error("KEY_VAULT_URL is required for dashboard password encryption");
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

function decodePasswordEncryptionKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Dashboard password encryption key must be Base64 encoded");
  }

  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("Dashboard password encryption key must decode to 32 bytes");
  }
  return key;
}

async function getPasswordEncryptionKey(options = {}) {
  const secretName = options.secretName ||
    process.env.DASHBOARD_PASSWORD_ENCRYPTION_KEY_SECRET_NAME ||
    DEFAULT_PASSWORD_ENCRYPTION_KEY_SECRET_NAME;
  const client = getSecretClient();
  const secret = await client.getSecret(
    secretName,
    options.secretVersion ? { version: options.secretVersion } : undefined,
  );
  return {
    key: decodePasswordEncryptionKey(secret.value),
    keySecretName: secretName,
    keyVersion: secret.properties.version || null,
  };
}

function encryptDashboardPassword(password, passwordEncryptionKey) {
  if (!passwordEncryptionKey?.key) {
    throw new Error("A dashboard password encryption key is required");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    passwordEncryptionKey.key,
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(String(password), "utf8"),
    cipher.final(),
  ]);

  return {
    algorithm: "AES-256-GCM",
    keySecretName: passwordEncryptionKey.keySecretName,
    keyVersion: passwordEncryptionKey.keyVersion || null,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptDashboardPassword(passwordEncryption, key) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(passwordEncryption.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(passwordEncryption.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(passwordEncryption.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = {
  DEFAULT_PASSWORD_ENCRYPTION_KEY_SECRET_NAME,
  decodePasswordEncryptionKey,
  getPasswordEncryptionKey,
  encryptDashboardPassword,
  decryptDashboardPassword,
};
