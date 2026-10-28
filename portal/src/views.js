export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const signOutIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/></svg>';
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('') || '?';

function account(user) {
  const name = user.name || user.email || 'SSW staff';
  return `<div class="account"><span class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</span><span class="account-name">${escapeHtml(name)}</span><a class="sign-out" href="/auth/logout" aria-label="Log out">${signOutIcon}<span>Log out</span></a></div>`;
}

export function page({ title, body, user }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | SSW TIGER</title><link rel="stylesheet" href="/assets/portal.css"></head><body>
  <header><div class="header-inner"><a class="brand" href="/"><img class="brand-logo" src="/assets/images/app-icon.svg" alt="SSW TIGER" width="128" height="30"></a>${user ? account(user) : ''}</div></header>
  <main>${body}</main></body></html>`;
}

const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 11h18"/></svg>';

export const RECENT_MEETINGS = 3;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const projectHref = project => `/${encodeURIComponent(project)}/`;
const STAT_UNITS = [['minutes', 'min'], ['people', 'people'], ['actionItems', 'action items']];

function meetingRow(project, meeting, { home = false } = {}) {
  const when = meeting.date ? `${meeting.weekday} · ${meeting.date}` : '';
  const stats = meeting.stats || {};
  const people = stats.people === undefined ? '' : `${stats.people} people`;
  const tooltip = [meeting.title, home ? people : ''].filter(Boolean).join(' · ');
  const calendar = home ? (meeting.date
    ? `<span class="date-tile" aria-hidden="true"><span class="date-month">${escapeHtml(meeting.month)}</span><span class="date-day">${escapeHtml(meeting.day)}</span></span>`
    : `<span class="date-tile date-tile-blank" aria-hidden="true">${folderIcon}</span>`) : '';
  const chips = STAT_UNITS
    .filter(([key]) => !(home && key === 'people') && stats[key] !== undefined)
    .map(([key, unit]) => `<span class="meeting-chip">${stats[key]} ${unit}</span>`).join('');
  return `<li><a class="meeting" href="${projectHref(project)}${encodeURIComponent(meeting.id)}/"${home ? ` title="${escapeHtml(tooltip)}"` : ''}>${calendar}<span class="meeting-details"><strong title="${escapeHtml(tooltip)}">${escapeHtml(meeting.title)}</strong>${when ? `<span class="meeting-when">${escapeHtml(when)}</span>` : ''}</span>${!home || chips ? `<span class="meeting-metadata">${chips}${home ? '' : '<span class="arrow" aria-hidden="true">›</span>'}</span>` : ''}</a></li>`;
}

function projectCard({ project, displayName, meetings }, index) {
  const more = meetings.length > RECENT_MEETINGS
    ? ` · <a class="view-all" href="${projectHref(project)}">View all <span aria-hidden="true">→</span></a>`
    : '';
  return `<article class="project-card" aria-labelledby="project-${index}"><header class="project-card-header"><span class="project-icon">${folderIcon}</span><div class="project-details"><h2 id="project-${index}"><a href="${projectHref(project)}">${escapeHtml(displayName)}</a></h2><p class="project-meta">${plural(meetings.length, 'meeting')}${more}</p></div></header><ul class="meetings">${meetings.slice(0, RECENT_MEETINGS).map(meeting => meetingRow(project, meeting, { home: true })).join('')}</ul></article>`;
}

export function projectsPage(projects, user) {
  const cards = projects.map(projectCard).join('');
  return page({ title: 'All projects', user, body: `<div class="heading"><div><div class="title-row"><h1>All projects</h1>${projects.length ? `<span class="count">${projects.length}</span>` : ''}</div>${projects.length ? '<p>The latest meeting reports from each project.</p>' : ''}</div></div>${cards ? `<section aria-label="Projects" class="project-grid">${cards}</section>` : `<section aria-label="Projects" class="empty"><span class="empty-icon">${folderIcon}</span><h2>No meeting reports yet</h2><p>When TIGER publishes a meeting report, its project shows up here with the latest meetings.</p></section>`}` });
}

export function projectPage({ project, displayName, meetings }, user) {
  return page({ title: displayName, user, body: `<div class="project-page"><nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">← All projects</a></nav><div class="heading project-heading"><div class="project-title"><span class="brand-squares" aria-hidden="true"><i></i><i></i><i></i><i></i></span><div><h1>${escapeHtml(displayName)}</h1><p>Meeting Dashboards</p></div></div><div class="meeting-count"><strong>${meetings.length}</strong><span>meetings</span></div></div><ul class="meetings project-meetings">${meetings.map(meeting => meetingRow(project, meeting)).join('')}</ul><footer class="project-footer">Generated by SSW Tiger</footer></div>` });
}

const alertIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/></svg>';

export function messagePage(title, message, action = '', status = '') {
  return page({ title, body: `<section class="message" aria-labelledby="message-title"><span class="empty-icon">${alertIcon}</span><h1 id="message-title">${escapeHtml(title)}</h1><p class="message-description">${escapeHtml(message)}</p>${action ? `<div class="message-actions">${action}</div>` : ''}${status ? `<p class="message-status">${escapeHtml(status)}</p>` : ''}</section>` });
}
