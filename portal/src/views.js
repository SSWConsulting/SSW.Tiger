import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessagePage, ProjectsPage, ProjectPage } from './components.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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

export function messagePage(title, message, action = '', status = '') {
  return reactPage(title, createElement(MessagePage, { title, message, action, status }));
}
