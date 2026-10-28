// Initial layout and icon sizes must not depend on Alpine initialization.
function ensureDashboardInitialClasses(html) {
  return html.replace(/<(div|button)\b[^>]*>/g, tag => {
    if (/\sclass\s*=/.test(tag)) return tag;
    const binding = tag.match(/\s:class="([^"]*)"/)?.[1];
    if (!binding) return tag;
    const base = ['ds-shell', 'ds-navitem', 'ds-topnav-item']
      .find(name => binding.includes(`'${name}'`));
    return base ? tag.replace(/^<(div|button)\b/, `$& class="${base}"`) : tag;
  });
}

module.exports = { ensureDashboardInitialClasses };
