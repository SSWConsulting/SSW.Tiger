import { createElement as h, Fragment } from 'react';

const projectHref = project => `/${encodeURIComponent(project)}/`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const RECENT_MEETINGS = 3;

const ICONS = {
  folder: { strokeWidth: 1.5, paths: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M3 11h18'] },
  logout: { strokeWidth: 1.75, paths: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 17l-5-5 5-5', 'M5 12h11'] },
  alert: { strokeWidth: 1.75, circle: true, paths: ['M12 8v4.5', 'M12 16h.01'] },
};

function Icon({ kind = 'folder' }) {
  const { strokeWidth, circle, paths } = ICONS[kind];
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    circle && h('circle', { cx: 12, cy: 12, r: 9 }), ...paths.map(d => h('path', { key: d, d })));
}

export function PortalLayout({ user, children }) {
  const name = user?.name || user?.email || 'SSW staff';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('') || '?';
  return h('div', null,
    h('header', null, h('div', { className: 'header-inner' },
      h('a', { className: 'brand', href: '/' }, h('img', { className: 'brand-logo', src: '/assets/images/app-icon.svg', alt: 'SSW TIGER', width: 128, height: 30 })),
      user && h('div', { className: 'account' },
        h('span', { className: 'avatar', 'aria-hidden': true }, initials),
        h('span', { className: 'account-name' }, name),
        h('a', { className: 'sign-out', href: '/auth/logout', 'aria-label': 'Log out' }, h(Icon, { kind: 'logout' }), h('span', null, 'Log out'))))),
    h('main', null, children));
}

function MeetingRow({ project, meeting, home = false }) {
  const stats = meeting.stats || {};
  const when = meeting.date ? `${meeting.weekday} · ${meeting.date}` : '';
  const tooltip = [meeting.title, home && stats.people !== undefined ? `${stats.people} people` : ''].filter(Boolean).join(' · ');
  const chips = [['minutes', 'min'], ['people', 'people'], ['actionItems', 'action items']]
    .filter(([key]) => stats[key] !== undefined)
    .map(([key, unit]) => h('span', { className: 'meeting-chip', key }, `${stats[key]} ${unit}`));
  return h('li', null, h('a', { className: 'meeting', href: `${projectHref(project)}${encodeURIComponent(meeting.id)}/`, ...(home ? { title: tooltip } : {}) },
    home && (meeting.date
      ? h('span', { className: 'date-tile', 'aria-hidden': true }, h('span', { className: 'date-month' }, meeting.month), h('span', { className: 'date-day' }, meeting.day))
      : h('span', { className: 'date-tile date-tile-blank', 'aria-hidden': true }, h(Icon))),
    h('span', { className: 'meeting-details' }, h('strong', { title: tooltip }, meeting.title), when && h('span', { className: 'meeting-when' }, when)),
    !home && h('span', { className: 'meeting-metadata' }, ...chips, h('span', { className: 'arrow', 'aria-hidden': true }, '›'))));
}

function ProjectCard({ project, index }) {
  return h('article', { className: 'project-card', 'aria-labelledby': `project-${index}` },
    h('header', { className: 'project-card-header' },
      h('span', { className: 'project-icon' }, h(Icon)),
      h('div', { className: 'project-details' },
        h('h2', { id: `project-${index}` }, h('a', { href: projectHref(project.project) }, project.displayName)),
        h('p', { className: 'project-meta' }, plural(project.meetings.length, 'meeting'),
          project.meetings.length > RECENT_MEETINGS && h(Fragment, null, ' · ', h('a', { className: 'view-all', href: projectHref(project.project) }, 'View all ', h('span', { 'aria-hidden': true }, '→')))))),
    h('ul', { className: 'meetings' }, ...project.meetings.slice(0, RECENT_MEETINGS).map(meeting => h(MeetingRow, { key: meeting.id, project: project.project, meeting, home: true }))));
}

export function ProjectsPage({ projects, user }) {
  return h(PortalLayout, { user },
    h('div', { className: 'heading' }, h('div', null,
      h('div', { className: 'title-row' }, h('h1', null, 'All projects'), projects.length > 0 && h('span', { className: 'count' }, projects.length)),
      projects.length > 0 && h('p', null, 'The latest meeting reports from each project.'))),
    projects.length > 0
      ? h('section', { 'aria-label': 'Projects', className: 'project-grid' }, ...projects.map((project, index) => h(ProjectCard, { key: project.project, project, index })))
      : h('section', { 'aria-label': 'Projects', className: 'empty' }, h('span', { className: 'empty-icon' }, h(Icon)),
        h('h2', null, 'No meeting reports yet'), h('p', null, 'When TIGER publishes a meeting report, its project shows up here with the latest meetings.')));
}

export function ProjectPage({ project, user }) {
  return h(PortalLayout, { user }, h('div', { className: 'project-page' },
    h('nav', { className: 'breadcrumb', 'aria-label': 'Breadcrumb' }, h('a', { href: '/' }, '← All projects')),
    h('div', { className: 'heading project-heading' },
      h('div', { className: 'project-title' }, h('span', { className: 'brand-squares', 'aria-hidden': true }, ...[0, 1, 2, 3].map(key => h('i', { key }))),
        h('div', null, h('h1', null, project.displayName), h('p', null, 'Meeting Dashboards'))),
      h('div', { className: 'meeting-count' }, h('strong', null, project.meetings.length), h('span', null, 'meetings'))),
    h('ul', { className: 'meetings project-meetings' }, ...project.meetings.map(meeting => h(MeetingRow, { key: meeting.id, project: project.project, meeting }))),
    h('footer', { className: 'project-footer' }, 'Generated by SSW Tiger')));
}

// Actions are trusted server-side markup (e.g. sign-in buttons), never request data.
export function MessagePage({ title, message, action, status }) {
  return h(PortalLayout, null, h('section', { className: 'message', 'aria-labelledby': 'message-title' },
    h('span', { className: 'empty-icon' }, h(Icon, { kind: 'alert' })),
    h('h1', { id: 'message-title' }, title),
    h('p', { className: 'message-description' }, message),
    action && h('div', { className: 'message-actions', dangerouslySetInnerHTML: { __html: action } }),
    status && h('p', { className: 'message-status' }, status)));
}
