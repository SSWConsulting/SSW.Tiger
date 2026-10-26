// Accepts a bare hostname or a full HTTPS origin, so URLs never get a doubled scheme or slash
function dashboardUrl(baseUrl, segments = []) {
  const value = String(baseUrl || '').trim();
  if (!value) throw new Error('Dashboard base URL is required');
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Dashboard base URL must be an HTTPS hostname without a path, credentials, query or fragment');
  }
  return `${url.origin}/${segments.map(encodeURIComponent).join('/')}`;
}

module.exports = { dashboardUrl };
