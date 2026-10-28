import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectsPage, ProjectPage } from './components.js';

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

export { RECENT_MEETINGS } from './components.js';

function reactPage(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | SSW TIGER</title><link rel="stylesheet" href="/assets/portal.css"></head><body>${renderToStaticMarkup(content)}</body></html>`;
}

export function projectsPage(projects, user) {
  return reactPage('All projects', createElement(ProjectsPage, { projects, user }));
}

export function projectPage(project, user) {
  return reactPage(project.displayName, createElement(ProjectPage, { project, user }));
}

const alertIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/></svg>';

export function messagePage(title, message, action = '', status = '') {
  return page({ title, body: `<section class="message" aria-labelledby="message-title"><span class="empty-icon">${alertIcon}</span><h1 id="message-title">${escapeHtml(title)}</h1><p class="message-description">${escapeHtml(message)}</p>${action ? `<div class="message-actions">${action}</div>` : ''}${status ? `<p class="message-status">${escapeHtml(status)}</p>` : ''}</section>` });
}
