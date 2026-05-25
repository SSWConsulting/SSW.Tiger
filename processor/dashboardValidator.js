/**
 * Dashboard Validator & Repair
 *
 * The dashboard's inline `tailwind.config` <script> block is pure static
 * styling configuration (SSW colour palettes + font stack) with no
 * per-meeting data. The model has no business regenerating it from
 * scratch, but it does, and every regeneration is a chance to introduce
 * a typo that breaks the whole palette and leaves the dashboard mostly
 * black-and-white with invisible text (see GitHub issue #98).
 *
 * Rather than detect-and-repair (PR #99's approach, which only catches
 * SyntaxErrors and missed runtime ReferenceErrors like an unquoted
 * `sans-serif` parsing as `sans - serif`), this module unconditionally
 * overwrites the dashboard's `tailwind.config` block with the canonical
 * one from templates/dashboard.html. Whatever the model emitted for
 * that block is discarded.
 *
 * Other inline scripts (chart setup, profile-image fallback) are
 * parse-checked as a non-fatal diagnostic only - we have no canonical
 * version to stamp in for those, so we just log a warning if any of
 * them fail to parse.
 */

const fs = require("fs").promises;
const { log } = require("../lib/logger");

const SCRIPT_BLOCK_REGEX = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
const TAILWIND_CONFIG_MARKER = /tailwind\.config\s*=\s*\{/;

/**
 * Find inline <script> blocks (those without a `src` attribute) and
 * return their bodies.
 */
function extractInlineScripts(html) {
  const blocks = [];
  for (const match of html.matchAll(SCRIPT_BLOCK_REGEX)) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (!body.trim()) continue;
    blocks.push({ attrs, body, full: match[0], index: match.index });
  }
  return blocks;
}

/**
 * Find the inline <script> block that assigns to `tailwind.config`.
 * Returns null if none found.
 */
function findTailwindConfigScript(html) {
  for (const block of extractInlineScripts(html)) {
    if (TAILWIND_CONFIG_MARKER.test(block.body)) {
      return block;
    }
  }
  return null;
}

/**
 * Parse-check a script body via `new Function`. Returns the error if
 * parsing fails, null otherwise. Used as a non-fatal diagnostic for
 * non-tailwind inline scripts.
 */
function findSyntaxError(body) {
  try {
    new Function(body);
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Unconditionally replace the dashboard's `tailwind.config` <script>
 * block with the canonical one from the template. Writes the file only
 * if the block actually differed.
 *
 * Also parse-checks every other inline script and logs a warning if any
 * fail (non-fatal - we cannot auto-repair those).
 *
 * @param {string} dashboardPath - absolute path to dashboard HTML
 * @param {string} templatePath - absolute path to templates/dashboard.html
 * @returns {Promise<{ok: boolean, repaired: boolean, reason?: string}>}
 */
async function validateAndRepairDashboard(dashboardPath, templatePath) {
  const html = await fs.readFile(dashboardPath, "utf8");

  const dashboardBlock = findTailwindConfigScript(html);
  if (!dashboardBlock) {
    log("warn", "Dashboard has no tailwind.config block - cannot stamp canonical version");
    return { ok: false, repaired: false, reason: "no-tailwind-block-in-dashboard" };
  }

  const template = await fs.readFile(templatePath, "utf8");
  const canonicalBlock = findTailwindConfigScript(template);
  if (!canonicalBlock) {
    log("warn", "Template has no tailwind.config block - skipping repair");
    return { ok: false, repaired: false, reason: "template-block-not-found" };
  }

  const blocksMatch = dashboardBlock.full === canonicalBlock.full;

  if (!blocksMatch) {
    const repairedHtml =
      html.slice(0, dashboardBlock.index) +
      canonicalBlock.full +
      html.slice(dashboardBlock.index + dashboardBlock.full.length);
    await fs.writeFile(dashboardPath, repairedHtml);
    log("info", "Dashboard tailwind.config block overwritten with canonical version", {
      dashboardPath,
    });
    warnOnOtherScriptParseFailures(repairedHtml);
    return { ok: true, repaired: true };
  }

  warnOnOtherScriptParseFailures(html);
  return { ok: true, repaired: false };
}

/**
 * Parse-check every inline script *except* the tailwind.config block
 * (which is now canonical by construction). Logs a warning if any
 * fail - non-fatal, since we have no canonical version to stamp in
 * for those.
 */
function warnOnOtherScriptParseFailures(html) {
  const failures = extractInlineScripts(html)
    .filter((s) => !TAILWIND_CONFIG_MARKER.test(s.body))
    .map((s) => ({ ...s, error: findSyntaxError(s.body) }))
    .filter((s) => s.error);

  if (failures.length > 0) {
    log("warn", "Non-tailwind inline <script>(s) failed to parse - cannot auto-repair", {
      failureCount: failures.length,
      firstError: failures[0].error.message,
    });
  }
}

module.exports = {
  validateAndRepairDashboard,
  extractInlineScripts,
  findTailwindConfigScript,
  findSyntaxError,
};
