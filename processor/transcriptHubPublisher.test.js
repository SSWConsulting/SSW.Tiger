const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  publishTranscript,
  fetchAllowlistSlugs,
  getInstallationToken,
  mintAppJwt,
  gitBlobSha,
} = require("./transcriptHubPublisher");

const HUB_ENV_VARS = [
  "TRANSCRIPT_HUB_REPO",
  "TRANSCRIPT_HUB_TOKEN",
  "TRANSCRIPT_HUB_APP_ID",
  "TRANSCRIPT_HUB_APP_PRIVATE_KEY",
  "TRANSCRIPT_HUB_APP_INSTALLATION_ID",
];

const VTT_CONTENT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Eli Kent [SSW]>Hello.</v>\n";

let savedEnv;
let savedFetch;
let fetchCalls;
let transcriptPath;

function mockFetch(handler) {
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    const result = handler(url, options);
    return {
      status: result.status,
      json: async () => {
        if (result.json === undefined) throw new Error("no body");
        return result.json;
      },
    };
  };
}

function allowlistResponse(slugs) {
  const apps = { apps: slugs.map((slug) => ({ slug })) };
  return {
    status: 200,
    json: {
      content: Buffer.from(JSON.stringify(apps)).toString("base64"),
    },
  };
}

beforeEach(async () => {
  savedEnv = {};
  for (const name of HUB_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  savedFetch = global.fetch;
  fetchCalls = [];

  transcriptPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "hub-test-")),
    "2026-08-11-102829.vtt",
  );
  await fs.writeFile(transcriptPath, VTT_CONTENT);
});

afterEach(() => {
  for (const name of HUB_ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  global.fetch = savedFetch;
});

describe("publishTranscript", () => {
  it("is a no-op when TRANSCRIPT_HUB_REPO is unset", async () => {
    const result = await publishTranscript({
      transcriptPath,
      projectSlug: "tinacloud",
      meetingId: "2026-08-11-102829",
    });
    assert.deepEqual(result, { published: false, reason: "disabled" });
    assert.equal(fetchCalls.length, 0);
  });

  it("throws when the repo is set but no credentials are", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    await assert.rejects(
      publishTranscript({
        transcriptPath,
        projectSlug: "tinacloud",
        meetingId: "2026-08-11-102829",
      }),
      /no credentials/,
    );
  });

  it("rejects a slug that is not sanitizeId output, before any network call", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    process.env.TRANSCRIPT_HUB_TOKEN = "test-token";
    mockFetch(() => {
      throw new Error("no request expected");
    });

    await assert.rejects(
      publishTranscript({
        transcriptPath,
        projectSlug: "../evil",
        meetingId: "2026-08-11-102829",
      }),
      /invalid project slug/,
    );
    assert.equal(fetchCalls.length, 0);
  });

  it("skips projects that are not in the hub allowlist", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    process.env.TRANSCRIPT_HUB_TOKEN = "test-token";
    mockFetch(() => allowlistResponse(["yakshaver"]));

    const result = await publishTranscript({
      transcriptPath,
      projectSlug: "tinacloud",
      meetingId: "2026-08-11-102829",
    });

    assert.deepEqual(result, { published: false, reason: "not-allowlisted" });
    assert.equal(fetchCalls.length, 1);
  });

  it("creates the hub file when it does not exist yet", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    process.env.TRANSCRIPT_HUB_TOKEN = "test-token";
    mockFetch((url, options) => {
      if (url.endsWith("/contents/apps.json")) {
        return allowlistResponse(["tinacloud"]);
      }
      if (options.method === "GET") return { status: 404, json: {} };
      return { status: 201, json: { content: {} } };
    });

    const result = await publishTranscript({
      transcriptPath,
      projectSlug: "tinacloud",
      meetingId: "2026-08-11-102829",
    });

    assert.equal(result.published, true);
    assert.equal(result.path, "transcripts/tinacloud/2026-08-11-102829.vtt");

    const put = fetchCalls.find((c) => c.options.method === "PUT");
    assert.ok(put.url.endsWith("/contents/transcripts/tinacloud/2026-08-11-102829.vtt"));
    const body = JSON.parse(put.options.body);
    assert.equal(Buffer.from(body.content, "base64").toString(), VTT_CONTENT);
    assert.equal(body.sha, undefined);
    assert.equal(put.options.headers.Authorization, "Bearer test-token");
    assert.ok(put.options.signal instanceof AbortSignal);
  });

  it("retries the PUT once when the branch ref update conflicts (409)", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    process.env.TRANSCRIPT_HUB_TOKEN = "test-token";
    let putCount = 0;
    mockFetch((url, options) => {
      if (url.endsWith("/contents/apps.json")) {
        return allowlistResponse(["tinacloud"]);
      }
      if (options.method === "GET") return { status: 404, json: {} };
      putCount += 1;
      return putCount === 1
        ? { status: 409, json: { message: "is at ... but expected ..." } }
        : { status: 201, json: { content: {} } };
    });

    const result = await publishTranscript({
      transcriptPath,
      projectSlug: "tinacloud",
      meetingId: "2026-08-11-102829",
    });

    assert.equal(result.published, true);
    assert.equal(putCount, 2);
  });

  it("gives up after the second 409 rather than looping", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    process.env.TRANSCRIPT_HUB_TOKEN = "test-token";
    mockFetch((url, options) => {
      if (url.endsWith("/contents/apps.json")) {
        return allowlistResponse(["tinacloud"]);
      }
      if (options.method === "GET") return { status: 404, json: {} };
      return { status: 409, json: {} };
    });

    await assert.rejects(
      publishTranscript({
        transcriptPath,
        projectSlug: "tinacloud",
        meetingId: "2026-08-11-102829",
      }),
      /Failed to publish transcript to hub: 409/,
    );
  });

  it("updates in place (passing sha) when the hub file differs", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    process.env.TRANSCRIPT_HUB_TOKEN = "test-token";
    mockFetch((url, options) => {
      if (url.endsWith("/contents/apps.json")) {
        return allowlistResponse(["tinacloud"]);
      }
      if (options.method === "GET") {
        return { status: 200, json: { sha: "different-sha" } };
      }
      return { status: 200, json: { content: {} } };
    });

    const result = await publishTranscript({
      transcriptPath,
      projectSlug: "tinacloud",
      meetingId: "2026-08-11-102829",
    });

    assert.equal(result.published, true);
    const put = fetchCalls.find((c) => c.options.method === "PUT");
    assert.equal(JSON.parse(put.options.body).sha, "different-sha");
  });

  it("skips the publish when the hub already has identical bytes", async () => {
    process.env.TRANSCRIPT_HUB_REPO = "SSWConsulting/SSW.Tiger-Transcripts";
    process.env.TRANSCRIPT_HUB_TOKEN = "test-token";
    const identicalSha = gitBlobSha(Buffer.from(VTT_CONTENT));
    mockFetch((url, options) => {
      if (url.endsWith("/contents/apps.json")) {
        return allowlistResponse(["tinacloud"]);
      }
      if (options.method === "GET") {
        return { status: 200, json: { sha: identicalSha } };
      }
      throw new Error("PUT should not happen for identical content");
    });

    const result = await publishTranscript({
      transcriptPath,
      projectSlug: "tinacloud",
      meetingId: "2026-08-11-102829",
    });

    assert.equal(result.published, false);
    assert.equal(result.reason, "unchanged");
  });
});

describe("fetchAllowlistSlugs", () => {
  it("accepts both object and bare-string entries", async () => {
    const apps = { apps: [{ slug: "tinacloud" }, "yakshaver"] };
    mockFetch(() => ({
      status: 200,
      json: { content: Buffer.from(JSON.stringify(apps)).toString("base64") },
    }));

    const slugs = await fetchAllowlistSlugs("owner/repo", "t");
    assert.deepEqual(slugs, ["tinacloud", "yakshaver"]);
  });

  it("throws on a malformed apps.json", async () => {
    mockFetch(() => ({
      status: 200,
      json: { content: Buffer.from('{"nope": true}').toString("base64") },
    }));
    await assert.rejects(fetchAllowlistSlugs("owner/repo", "t"), /malformed/);
  });
});

describe("GitHub App auth", () => {
  it("mints a verifiable RS256 JWT", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });

    const jwt = mintAppJwt("12345", privateKey.export({ type: "pkcs8", format: "pem" }));
    const [header, payload, signature] = jwt.split(".");

    const verified = crypto
      .createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature, "base64url");
    assert.equal(verified, true);

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, "12345");
    assert.ok(claims.exp > claims.iat);
  });

  it("exchanges the JWT for an installation token", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    mockFetch((url) => {
      assert.ok(url.endsWith("/app/installations/42/access_tokens"));
      return { status: 201, json: { token: "ghs_installation" } };
    });

    const token = await getInstallationToken({
      appId: "12345",
      appPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
      appInstallationId: "42",
    });
    assert.equal(token, "ghs_installation");
  });
});

describe("gitBlobSha", () => {
  it("matches git hash-object output", () => {
    // echo -n "hello" | git hash-object --stdin
    assert.equal(
      gitBlobSha(Buffer.from("hello")),
      "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
    );
  });
});
