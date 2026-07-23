// 定位 Cosmos 取 token 卡住的根因。只读，不写任何 Azure 数据。
//
//   node debug-credential.js            逐个凭据试，看谁能拿到 token
//   node debug-credential.js --verbose  打开 @azure/identity 的详细日志
//
// 删掉这个文件不影响任何功能——它只是排障工具。

const SCOPE = "https://cosmos.azure.com/.default";
const TIMEOUT_MS = 20000;

const settings = require("./local.settings.json").Values;
for (const [k, v] of Object.entries(settings)) if (!k.startsWith("_")) process.env[k] = v;

const verbose = process.argv.includes("--verbose");
if (verbose) {
  process.env.AZURE_LOG_LEVEL = "verbose";
  require("@azure/logger").setLogLevel("verbose");
}

const identity = require("@azure/identity");

function mask(v) {
  if (!v) return "(未设置)";
  return v.length <= 8 ? "***" : `${v.slice(0, 4)}…${v.slice(-2)} (len=${v.length})`;
}

async function attempt(name, makeCredential) {
  const started = Date.now();
  let timer;
  try {
    const credential = makeCredential();
    const token = await Promise.race([
      credential.getToken(SCOPE),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      }),
    ]);
    const ms = Date.now() - started;
    if (!token) return console.log(`  ❌ ${name.padEnd(26)} ${String(ms).padStart(6)}ms  返回 null`);
    const expires = new Date(token.expiresOnTimestamp).toISOString();
    console.log(
      `  ✅ ${name.padEnd(26)} ${String(ms).padStart(6)}ms  token 长度=${token.token.length} 过期=${expires}`,
    );
  } catch (error) {
    console.log(
      `  ❌ ${name.padEnd(26)} ${String(Date.now() - started).padStart(6)}ms  ${error.message.split("\n")[0]}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log("=== 相关环境变量 ===");
  for (const k of [
    "AZURE_TOKEN_CREDENTIALS",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_CLIENT_CERTIFICATE_PATH",
    "AZURE_USERNAME",
    "MSI_ENDPOINT",
    "IDENTITY_ENDPOINT",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ]) {
    console.log(`  ${k.padEnd(30)} = ${k.includes("SECRET") ? mask(process.env[k]) : process.env[k] || "(未设置)"}`);
  }

  console.log(`\n=== 逐个凭据取 ${SCOPE} ===`);
  await attempt("EnvironmentCredential", () => new identity.EnvironmentCredential());
  await attempt("AzureCliCredential", () => new identity.AzureCliCredential());
  await attempt("AzurePowerShellCredential", () => new identity.AzurePowerShellCredential());
  await attempt("AzureDeveloperCliCredential", () => new identity.AzureDeveloperCliCredential());
  await attempt("ManagedIdentityCredential", () => new identity.ManagedIdentityCredential());

  console.log("\n=== DefaultAzureCredential（两种模式对比）===");
  const saved = process.env.AZURE_TOKEN_CREDENTIALS;
  process.env.AZURE_TOKEN_CREDENTIALS = "dev";
  await attempt("Default (dev)", () => new identity.DefaultAzureCredential());
  delete process.env.AZURE_TOKEN_CREDENTIALS;
  await attempt("Default (完整链)", () => new identity.DefaultAzureCredential());
  if (saved !== undefined) process.env.AZURE_TOKEN_CREDENTIALS = saved;

  console.log("\n哪一行是 ✅ 且够快，就把 local.settings.json 的 AZURE_TOKEN_CREDENTIALS 设成对应值");
  console.log("（可填具体凭据名，如 AzureCliCredential / EnvironmentCredential，或 dev / prod，或整行删掉走完整链）");
  process.exit(0);
})();
