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
  // 页面数据只能由通过鉴权的服务端请求注入，不能从 URL 或 Cookie 直接读取。
  if (!req.portalPage) return { notFound: true };
  res.setHeader('Cache-Control', 'private, no-store');
  return { props: req.portalPage };
}
