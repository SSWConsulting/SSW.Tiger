const fs = require('node:fs/promises');
const path = require('node:path');
const { getWebContainerClient, dashboardHtmlHttpHeaders } = require('../lib/dashboardBlob');
const { dashboardUrl } = require('../lib/dashboardUrl');
const { formatDate } = require('./projectIndex');
const { log } = require('../lib/logger');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Only list folders with a published project index, so every link resolves; indexes
// published before displayname metadata existed show their slug
function projectsFromBlobs(blobs) {
  const projects = new Map();
  for (const blob of blobs) {
    const match = /^([^/]+)\/index\.html$/.exec(blob.name);
    if (!match || match[1] === '.' || match[1] === '..') continue;
    projects.set(match[1], { projectName: match[1], displayName: decodeDisplayName(blob.metadata?.displayname) || match[1] });
  }
  return [...projects.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function decodeDisplayName(value) {
  try {
    return value ? decodeURIComponent(value) : '';
  } catch {
    return '';
  }
}

function renderPortalIndex({ template, projects, generatedAt }) {
  const projectList = projects.map(({ projectName, displayName }) =>
    `<a class="project" href="./${encodeURIComponent(projectName)}/">
      <div><h2 class="project-name">${escapeHtml(displayName || projectName)}</h2><p class="project-description">View meeting dashboards</p></div>
      <span class="project-arrow" aria-hidden="true">&rsaquo;</span>
    </a>`
  ).join('\n');
  const values = {
    PROJECT_COUNT: projects.length,
    PROJECT_LIST: projectList || '<div class="empty"><h2>No projects yet</h2><p>Projects will appear here once their meeting dashboard pages are published.</p></div>',
    GENERATED_AT: escapeHtml(formatDate(generatedAt)),
  };
  return template.replace(/\{\{(PROJECT_COUNT|PROJECT_LIST|GENERATED_AT)\}\}/g, (_, key) => values[key]);
}

async function deployPortalIndex({ container = getWebContainerClient() } = {}) {
  const url = process.env.DASHBOARD_BASE_URL ? dashboardUrl(process.env.DASHBOARD_BASE_URL) : '/';
  const template = await fs.readFile(path.join(__dirname, '..', 'templates', 'portal-index.html'), 'utf8');
  const blob = container.getBlockBlobClient('index.html');
  // ETag guard: a parallel job must not overwrite a newer portal with a stale listing.
  // On conflict, re-list and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    let etag;
    try {
      etag = (await blob.getProperties()).etag;
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    const blobs = [];
    for await (const item of container.listBlobsFlat({ includeMetadata: true })) {
      blobs.push({ name: item.name, metadata: item.metadata });
    }
    const projects = projectsFromBlobs(blobs);
    const html = renderPortalIndex({ template, projects, generatedAt: new Date().toISOString() });
    try {
      await blob.upload(html, Buffer.byteLength(html), {
        blobHTTPHeaders: dashboardHtmlHttpHeaders(),
        conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      });
      log('info', 'Portal index deployed', { url, projectCount: projects.length });
      return url;
    } catch (error) {
      if (error.statusCode !== 412 || attempt === 2) throw error;
    }
  }
}

module.exports = { projectsFromBlobs, renderPortalIndex, deployPortalIndex };
