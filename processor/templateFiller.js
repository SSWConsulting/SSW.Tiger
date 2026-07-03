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
 * Placeholder names that are pure deterministic metadata rather than
 * meeting content, so this module fills them directly instead of reading a
 * model-authored fragment. The model has no reliable notion of "now," so
 * GENERATED_AT is computed here the same way processor/projectIndex.js
 * already computes the identically-named placeholder for
 * templates/project-index.html - see GitHub issue #125.
 */
const DETERMINISTIC_PLACEHOLDERS = new Set(["GENERATED_AT"]);

/**
 * Format the current instant as a human-readable generation timestamp,
 * DD/MM/YYYY per CLAUDE.md's date convention.
 *
 * @param {Date} [date]
 * @returns {string}
 */
function formatGeneratedAt(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `Generated ${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

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
 * Strip a single wrapping markdown code fence (```html ... ``` or ``` ... ```)
 * from fragment content, in case the model wrote one despite being told not
 * to. Defensive only - does nothing to content that isn't fenced.
 *
 * @param {string} content
 * @returns {string}
 */
function stripCodeFence(content) {
  const match = content.trim().match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : content;
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
    const raw = await fs.readFile(fragmentPath, "utf-8");
    return stripCodeFence(raw);
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
 * Static chrome outside placeholder regions is never modified. Substitution
 * happens in a single pass over the original template text, so a fragment
 * whose content happens to contain a literal {{OTHER_PLACEHOLDER}} token is
 * never re-scanned or re-substituted.
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

  const values = {};
  for (const name of placeholders) {
    values[name] = DETERMINISTIC_PLACEHOLDERS.has(name)
      ? formatGeneratedAt()
      : await readFragment(fragmentsDir, name);
  }

  const html = template.replace(new RegExp(PLACEHOLDER_REGEX.source, "g"), (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, "utf-8");

  log("info", "Filled dashboard template deterministically", {
    outputPath,
    placeholderCount: placeholders.length,
  });

  return { outputPath, placeholders };
}

module.exports = {
  extractPlaceholderNames,
  fillDashboardTemplate,
  readFragment,
  DETERMINISTIC_PLACEHOLDERS,
  formatGeneratedAt,
};
