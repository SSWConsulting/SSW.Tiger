/**
 * Dashboard Template Filler (deterministic)
 *
 * Performs the {{PLACEHOLDER}} -> content substitution in code instead of
 * inside the model's generation. The model only ever authors the content
 * for each placeholder, written as an individual fragment file; this module
 * reads templates/dashboard.html, reads each fragment, and splices the
 * fragment content into the template.
 *
 * Static chrome that lives outside a {{PLACEHOLDER}} region - the
 * tailwind.config block, the sswColors constant, Chart.defaults, the
 * profile-image fallback script, tab navigation, page structure, etc. -
 * is never touched: it flows straight from templates/dashboard.html into
 * the final HTML, byte-for-byte, on every run. See GitHub issue #125.
 *
 * A missing or unreadable fragment degrades gracefully: the placeholder is
 * substituted with an empty string rather than the pipeline crashing. This
 * covers the legitimate case where a section has nothing to show (e.g. a
 * ceremony was skipped per CLAUDE.md) as well as the failure case where the
 * model forgot to write a fragment.
 */

const fs = require("fs").promises;
const path = require("path");
const { log } = require("../lib/logger");

const PLACEHOLDER_REGEX = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Extract the unique set of {{PLACEHOLDER}} names present in a template
 * string, in first-seen order.
 *
 * @param {string} template
 * @returns {string[]}
 */
function extractPlaceholderNames(template) {
  const seen = new Set();
  for (const match of template.matchAll(PLACEHOLDER_REGEX)) {
    seen.add(match[1]);
  }
  return [...seen];
}

/**
 * Read a single placeholder's fragment file. Returns an empty string
 * (rather than throwing) when the fragment is missing or unreadable, so a
 * corrupted/missing fragment degrades to an empty section instead of
 * breaking the page.
 *
 * @param {string} fragmentsDir
 * @param {string} name - placeholder name, e.g. "SUMMARY"
 * @returns {Promise<string>}
 */
async function readFragment(fragmentsDir, name) {
  const fragmentPath = path.join(fragmentsDir, `${name}.html`);
  try {
    return await fs.readFile(fragmentPath, "utf-8");
  } catch (error) {
    log("warn", "Dashboard fragment missing or unreadable - substituting empty string", {
      placeholder: name,
      fragmentPath,
    });
    return "";
  }
}

/**
 * Read the dashboard template, substitute every {{PLACEHOLDER}} with the
 * content of its fragment file, and write the final HTML to outputPath.
 * Static chrome outside placeholder regions is never modified.
 *
 * @param {Object} params
 * @param {string} params.templatePath - absolute path to templates/dashboard.html
 * @param {string} params.fragmentsDir - absolute path to the meeting's dashboard-parts/ directory
 * @param {string} params.outputPath - absolute path to write the final dashboard/index.html
 * @returns {Promise<{ outputPath: string, placeholders: string[] }>}
 */
async function fillDashboardTemplate({ templatePath, fragmentsDir, outputPath }) {
  const template = await fs.readFile(templatePath, "utf-8");
  const placeholders = extractPlaceholderNames(template);

  let html = template;
  for (const name of placeholders) {
    const value = await readFragment(fragmentsDir, name);
    html = html.split(`{{${name}}}`).join(value);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, "utf-8");

  log("info", "Filled dashboard template deterministically", {
    outputPath,
    placeholderCount: placeholders.length,
  });

  return { outputPath, placeholders };
}

module.exports = { extractPlaceholderNames, fillDashboardTemplate, readFragment };
