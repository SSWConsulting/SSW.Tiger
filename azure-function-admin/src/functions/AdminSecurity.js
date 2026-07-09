const { app } = require("@azure/functions");

const {
  listProjects,
  listProjectPolicies,
  getProjectPolicy,
  upsertProjectPolicy,
  queryMeetings,
  getMeetingSecurity,
  upsertMeetingSecurity,
} = require("../../lib/cosmosClient");
const {
  generateDashboardPassword,
  encryptDashboardHtml,
  decryptDashboardPayload,
  extractEncryptedPayloadFromUnlockPage,
  renderUnlockPage,
} = require("../../lib/dashboardEncryption");
const {
  setMeetingPasswordSecret,
  getMeetingPasswordSecret,
} = require("../../lib/keyVaultPasswords");
const {
  downloadDashboardHtml,
  uploadDashboardHtml,
} = require("../../lib/dashboardBlob");
const { sanitizeId } = require("../../lib/sanitize");

const LOG_PREFIX = "[TIGER-ADMIN]";

function structuredLog(context, level, message, data = {}) {
  const entry = { level, message: `${LOG_PREFIX} ${message}`, ...data };
  if (level === "error") context.error(JSON.stringify(entry));
  else if (level === "warn") context.warn(JSON.stringify(entry));
  else context.log(JSON.stringify(entry));
}

function json(status, body) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    jsonBody: body,
  };
}

function html(status, body) {
  return {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
    body,
  };
}

function getCurrentUser(request) {
  const encoded = request.headers.get("x-ms-client-principal");
  if (!encoded) return null;

  const principal = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const claims = principal.claims || [];
  const claimValue = (name) => claims.find((claim) => claim.typ === name)?.val;
  const suffixClaimValue = (suffix) =>
    claims.find((claim) => String(claim.typ).endsWith(suffix))?.val;

  const email = (
    claimValue("preferred_username") ||
    claimValue("email") ||
    suffixClaimValue("/emailaddress") ||
    principal.userDetails ||
    ""
  ).toLowerCase();

  return {
    email,
    userId: principal.userId,
    authType: principal.auth_typ,
    claims,
  };
}

function tigerAdminEmails() {
  return (process.env.TIGER_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isTigerAdmin(user) {
  return !!user?.email && tigerAdminEmails().includes(user.email);
}

function isProjectAdmin(user, policy) {
  const admins = (policy?.projectAdmins || []).map((email) =>
    String(email).toLowerCase(),
  );
  return !!user?.email && admins.includes(user.email);
}

async function authorizeProject(request, context, projectName) {
  const user = getCurrentUser(request);
  if (!user?.email) {
    structuredLog(context, "warn", "Missing Easy Auth user");
    return { ok: false, response: json(401, { error: "Authentication required" }) };
  }

  if (isTigerAdmin(user)) {
    return { ok: true, user, policy: await getProjectPolicy(projectName), tigerAdmin: true };
  }

  const policy = await getProjectPolicy(projectName);
  if (isProjectAdmin(user, policy)) {
    return { ok: true, user, policy, tigerAdmin: false };
  }

  structuredLog(context, "warn", "Admin access denied", {
    email: user.email,
    projectName,
  });
  return { ok: false, response: json(403, { error: "Access denied" }) };
}

function normalizeProjectAdmins(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((email) => email.trim().toLowerCase()).filter(Boolean);
  }
  return String(value || "")
    .split(/[\n,;]/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function readBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const text = await request.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

async function mergedProjectsForUser(user) {
  const [meetingProjects, policies] = await Promise.all([
    listProjects(),
    listProjectPolicies(),
  ]);

  const byProject = new Map();
  for (const projectName of meetingProjects) {
    byProject.set(projectName, {
      projectName,
      passwordProtectionEnabled: false,
      projectAdmins: [],
    });
  }
  for (const policy of policies) {
    byProject.set(policy.projectName, {
      ...byProject.get(policy.projectName),
      projectName: policy.projectName,
      passwordProtectionEnabled: !!policy.passwordProtectionEnabled,
      projectAdmins: policy.projectAdmins || [],
    });
  }

  const projects = [...byProject.values()].sort((a, b) =>
    a.projectName.localeCompare(b.projectName),
  );

  if (isTigerAdmin(user)) return projects;
  return projects.filter((project) => isProjectAdmin(user, project));
}

async function protectMeeting({ projectName, meetingId, user, rotate }) {
  const sanitizedProject = sanitizeId(projectName) || "general";
  const existingSecurity = await getMeetingSecurity(sanitizedProject, meetingId);

  if (existingSecurity?.passwordEnabled && !rotate) {
    return {
      status: 409,
      body: { error: "Meeting already has password protection enabled" },
    };
  }

  const currentHtml = await downloadDashboardHtml(sanitizedProject, meetingId);
  let dashboardHtml = currentHtml;
  const encryptedPayload = extractEncryptedPayloadFromUnlockPage(currentHtml);
  if (encryptedPayload) {
    if (!existingSecurity?.passwordSecretName) {
      throw new Error("Dashboard is encrypted but no password secret is recorded");
    }
    const oldPassword = await getMeetingPasswordSecret(existingSecurity.passwordSecretName);
    dashboardHtml = decryptDashboardPayload(encryptedPayload, oldPassword);
  }

  const password = generateDashboardPassword();
  const newPayload = encryptDashboardHtml(dashboardHtml, password);
  const unlockHtml = renderUnlockPage({
    projectName: sanitizedProject,
    meetingId,
    encryptedPayload: newPayload,
  });
  await uploadDashboardHtml(sanitizedProject, meetingId, unlockHtml);

  const passwordSecretName = await setMeetingPasswordSecret({
    projectName: sanitizedProject,
    meetingId,
    password,
  });

  const security = await upsertMeetingSecurity({
    projectName: sanitizedProject,
    meetingId,
    passwordEnabled: true,
    passwordSecretName,
    encryptedAt: new Date().toISOString(),
    updatedBy: user.email,
  });

  return {
    status: 200,
    body: {
      projectName: sanitizedProject,
      meetingId,
      password,
      security,
    },
  };
}

function renderAdminShell({ user, projects }) {
  const items = projects.map((project) => `
    <tr>
      <td>${escapeHtml(project.projectName)}</td>
      <td>${project.passwordProtectionEnabled ? "On" : "Off"}</td>
      <td>${escapeHtml((project.projectAdmins || []).join(", "))}</td>
      <td><a href="/admin/projects/${encodeURIComponent(project.projectName)}/security">Manage</a></td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tiger Admin</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #333; }
    table { border-collapse: collapse; width: 100%; margin-top: 20px; }
    th, td { border-bottom: 1px solid #e4e4e7; padding: 12px; text-align: left; }
    th { background: #f4f4f5; }
    a { color: #cc4141; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Tiger Admin</h1>
  <p>Signed in as ${escapeHtml(user.email)}</p>
  <table>
    <thead><tr><th>Project</th><th>Password protection</th><th>Project admins</th><th></th></tr></thead>
    <tbody>${items || "<tr><td colspan=\"4\">No projects available</td></tr>"}</tbody>
  </table>
</body>
</html>`;
}

function renderProjectSecurityPage({ projectName, user, policy, meetings, tigerAdmin }) {
  const meetingRows = meetings.map((meeting) => `
    <tr>
      <td>${escapeHtml(meeting.meetingDate || "")}</td>
      <td>${escapeHtml(meeting.meetingId)}</td>
      <td>
        <form method="POST" action="/api/admin/projects/${encodeURIComponent(projectName)}/meetings/${encodeURIComponent(meeting.meetingId)}/password/generate">
          <button type="submit">Generate</button>
        </form>
      </td>
      <td>
        <form method="POST" action="/api/admin/projects/${encodeURIComponent(projectName)}/meetings/${encodeURIComponent(meeting.meetingId)}/password/rotate">
          <button type="submit">Rotate</button>
        </form>
      </td>
      <td><a href="/api/admin/projects/${encodeURIComponent(projectName)}/meetings/${encodeURIComponent(meeting.meetingId)}/password">Show password</a></td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(projectName)} Security</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #333; }
    textarea { width: 420px; max-width: 100%; min-height: 80px; }
    table { border-collapse: collapse; width: 100%; margin-top: 24px; }
    th, td { border-bottom: 1px solid #e4e4e7; padding: 12px; text-align: left; vertical-align: top; }
    th { background: #f4f4f5; }
    button { background: #cc4141; color: white; border: 0; border-radius: 6px; padding: 8px 12px; font-weight: 700; cursor: pointer; }
    a { color: #cc4141; font-weight: 600; }
  </style>
</head>
<body>
  <p><a href="/admin">Back to projects</a></p>
  <h1>${escapeHtml(projectName)} security</h1>
  <p>Signed in as ${escapeHtml(user.email)}</p>
  <form method="POST" action="/api/admin/projects/${encodeURIComponent(projectName)}/policy">
    <label>
      <input type="checkbox" name="passwordProtectionEnabled" value="true" ${policy?.passwordProtectionEnabled ? "checked" : ""}>
      Password protect new dashboards
    </label>
    ${tigerAdmin ? `
      <h2>Project admins</h2>
      <textarea name="projectAdmins">${escapeHtml((policy?.projectAdmins || []).join("\n"))}</textarea>
    ` : ""}
    <p><button type="submit">Save policy</button></p>
  </form>
  <h2>Meetings</h2>
  <form method="POST" action="/api/admin/projects/${encodeURIComponent(projectName)}/encrypt-existing">
    <button type="submit">Encrypt existing dashboards</button>
  </form>
  <table>
    <thead><tr><th>Date</th><th>Meeting</th><th></th><th></th><th></th></tr></thead>
    <tbody>${meetingRows || "<tr><td colspan=\"5\">No meetings found</td></tr>"}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.http("AdminHome", {
  methods: ["GET"],
  route: "admin",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const user = getCurrentUser(request);
    if (!user?.email) return html(401, "Authentication required");
    const projects = await mergedProjectsForUser(user);
    return html(200, renderAdminShell({ user, projects }));
  },
});

app.http("AdminProjectSecurityPage", {
  methods: ["GET"],
  route: "admin/projects/{project}/security",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const projectName = sanitizeId(request.params.project) || "general";
    const auth = await authorizeProject(request, context, projectName);
    if (!auth.ok) return auth.response;
    const meetings = await queryMeetings({ projectName, excludeConsolidated: true });
    return html(200, renderProjectSecurityPage({
      projectName,
      user: auth.user,
      policy: auth.policy,
      meetings,
      tigerAdmin: auth.tigerAdmin,
    }));
  },
});

app.http("AdminProjectsApi", {
  methods: ["GET"],
  route: "api/admin/projects",
  authLevel: "anonymous",
  handler: async (request) => {
    const user = getCurrentUser(request);
    if (!user?.email) return json(401, { error: "Authentication required" });
    return json(200, { projects: await mergedProjectsForUser(user) });
  },
});

app.http("AdminProjectPolicyApi", {
  methods: ["GET", "POST"],
  route: "api/admin/projects/{project}/policy",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const projectName = sanitizeId(request.params.project) || "general";
    const auth = await authorizeProject(request, context, projectName);
    if (!auth.ok) return auth.response;

    if (request.method === "GET") {
      return json(200, { policy: auth.policy });
    }

    const body = await readBody(request);
    const wantsAdminUpdate = Object.prototype.hasOwnProperty.call(body, "projectAdmins");
    if (wantsAdminUpdate && !auth.tigerAdmin) {
      return json(403, { error: "Only Tiger Admins can update project admins" });
    }

    const policy = await upsertProjectPolicy({
      projectName,
      passwordProtectionEnabled:
        body.passwordProtectionEnabled === true ||
        body.passwordProtectionEnabled === "true" ||
        body.passwordProtectionEnabled === "on",
      projectAdmins: wantsAdminUpdate
        ? normalizeProjectAdmins(body.projectAdmins)
        : auth.policy?.projectAdmins || [],
      updatedBy: auth.user.email,
    });

    const accept = request.headers.get("accept") || "";
    if (accept.includes("text/html")) {
      return {
        status: 303,
        headers: { Location: `/admin/projects/${encodeURIComponent(projectName)}/security` },
      };
    }
    return json(200, { policy });
  },
});

app.http("AdminProjectMeetingsApi", {
  methods: ["GET"],
  route: "api/admin/projects/{project}/meetings",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const projectName = sanitizeId(request.params.project) || "general";
    const auth = await authorizeProject(request, context, projectName);
    if (!auth.ok) return auth.response;
    const meetings = await queryMeetings({ projectName, excludeConsolidated: true });
    return json(200, { meetings });
  },
});

app.http("AdminMeetingPasswordApi", {
  methods: ["GET"],
  route: "api/admin/projects/{project}/meetings/{meetingId}/password",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const projectName = sanitizeId(request.params.project) || "general";
    const meetingId = sanitizeId(request.params.meetingId);
    const auth = await authorizeProject(request, context, projectName);
    if (!auth.ok) return auth.response;

    const security = await getMeetingSecurity(projectName, meetingId);
    if (!security?.passwordEnabled || !security.passwordSecretName) {
      return json(404, { error: "Password is not enabled for this meeting" });
    }

    const password = await getMeetingPasswordSecret(security.passwordSecretName);
    return json(200, { projectName, meetingId, password, security });
  },
});

app.http("AdminMeetingPasswordGenerateApi", {
  methods: ["POST"],
  route: "api/admin/projects/{project}/meetings/{meetingId}/password/generate",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const projectName = sanitizeId(request.params.project) || "general";
    const meetingId = sanitizeId(request.params.meetingId);
    const auth = await authorizeProject(request, context, projectName);
    if (!auth.ok) return auth.response;

    const result = await protectMeeting({
      projectName,
      meetingId,
      user: auth.user,
      rotate: false,
    });
    structuredLog(context, "info", "Generated meeting password", {
      projectName,
      meetingId,
      updatedBy: auth.user.email,
    });
    return json(result.status, result.body);
  },
});

app.http("AdminMeetingPasswordRotateApi", {
  methods: ["POST"],
  route: "api/admin/projects/{project}/meetings/{meetingId}/password/rotate",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const projectName = sanitizeId(request.params.project) || "general";
    const meetingId = sanitizeId(request.params.meetingId);
    const auth = await authorizeProject(request, context, projectName);
    if (!auth.ok) return auth.response;

    const result = await protectMeeting({
      projectName,
      meetingId,
      user: auth.user,
      rotate: true,
    });
    structuredLog(context, "info", "Rotated meeting password", {
      projectName,
      meetingId,
      updatedBy: auth.user.email,
    });
    return json(result.status, result.body);
  },
});

app.http("AdminEncryptExistingApi", {
  methods: ["POST"],
  route: "api/admin/projects/{project}/encrypt-existing",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const projectName = sanitizeId(request.params.project) || "general";
    const auth = await authorizeProject(request, context, projectName);
    if (!auth.ok) return auth.response;

    const meetings = await queryMeetings({ projectName, excludeConsolidated: true });
    const results = [];
    for (const meeting of meetings) {
      const meetingId = sanitizeId(meeting.meetingId);
      const existing = await getMeetingSecurity(projectName, meetingId);
      if (existing?.passwordEnabled) {
        results.push({ meetingId, skipped: true, reason: "already protected" });
        continue;
      }

      try {
        const result = await protectMeeting({
          projectName,
          meetingId,
          user: auth.user,
          rotate: false,
        });
        results.push({
          meetingId,
          success: result.status === 200,
          password: result.body.password,
          error: result.status === 200 ? null : result.body.error,
        });
      } catch (err) {
        results.push({ meetingId, success: false, error: err.message });
      }
    }

    structuredLog(context, "info", "Encrypted existing dashboards", {
      projectName,
      updatedBy: auth.user.email,
      total: results.length,
      protectedCount: results.filter((item) => item.success).length,
    });

    return json(200, { projectName, results });
  },
});
