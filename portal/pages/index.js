import Head from 'next/head';
import { createElement as h } from 'react';
import { ProjectPage, ProjectsPage } from '../src/components.js';

export default function PortalPage({ kind, projects, project, user }) {
  const title = kind === 'project' ? project.displayName : 'All projects';
  return h('div', null,
    h(Head, null, h('title', null, `${title} | SSW TIGER`)),
    kind === 'project' ? h(ProjectPage, { project, user }) : h(ProjectsPage, { projects, user }));
}

export function getServerSideProps({ req, res }) {
  // Page data is injected only by the authorized server request, never read from the URL or cookies.
  if (!req.portalPage) return { notFound: true };
  res.setHeader('Cache-Control', 'private, no-store');
  return { props: req.portalPage };
}
