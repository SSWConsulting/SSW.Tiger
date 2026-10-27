export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function page({ title, body, user, csrf = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | SSW TIGER</title><link rel="stylesheet" href="/assets/portal.css"></head><body>
  <header><a class="brand" href="/"><span class="ssw">SSW</span><span>TIGER <small>Meeting intelligence</small></span></a>${user ? `<div class="account"><span>${escapeHtml(user.name || user.email || 'SSW staff')}</span><form action="/auth/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="quiet" type="submit">Sign out</button></form></div>` : ''}</header>
  <main>${body}</main><footer>SSW TIGER · Transcript Intelligence Group Event Reasoning</footer></body></html>`;
}

export function projectsPage(projects, user, csrf) {
  const rows = projects.map(({ project, displayName }) => `<a class="project" href="/${encodeURIComponent(project)}/"><span><strong>${escapeHtml(displayName)}</strong><span class="description">Browse meeting reports</span></span><span class="arrow" aria-hidden="true">→</span></a>`).join('');
  return page({ title: 'All projects', user, csrf, body: `<div class="heading"><div><p class="eyebrow">MEETING REPORTS</p><h1>All projects</h1><p>Choose a project to explore its meeting reports.</p></div><span class="count">${projects.length} ${projects.length === 1 ? 'project' : 'projects'}</span></div><section aria-label="Projects" class="projects">${rows || '<div class="empty"><h2>No projects yet</h2><p>Projects appear here when their first meeting report is published.</p></div>'}</section>` });
}

export function messagePage(title, message, action = '') {
  return page({ title, body: `<section class="message"><p class="eyebrow">SSW TIGER</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${action}</section>` });
}
