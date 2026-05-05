/**
 * Dashboard Validator & Repair
 *
 * Guard against LLM-generated syntax errors in the dashboard's inline
 * <script> blocks. The Tailwind config block is the highest-blast-radius
 * target: a single typo there throws a SyntaxError, the entire
 * `tailwind.config = {...}` assignment never runs, and every utility
 * built on the custom palette (`ssw-red`, `ssw-charcoal`, `ssw-gray`)
 * silently produces no CSS — leaving the dashboard mostly black-and-white
 * with invisible text.
 *
 * After the model writes the dashboard HTML, this module:
 *   1. Extracts every inline <script> block.
 *   2. Parses each via `new Function(body)` to surface SyntaxErrors
 *      without executing the code.
 *   3. If any block fails to parse, replaces the corrupted
 *      `tailwind.config` block with the canonical version from
 *      templates/dashboard.html.
 *   4. Re-validates after repair and writes the fixed file.
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
 * Try to parse a script body as a function body. Returns the SyntaxError
 * (or other Error) if parsing fails, otherwise null. `new Function` only
 * parses the body; it does not execute it, so undefined free variables
 * (like `tailwind`) do not trigger a runtime error here.
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
 * Validate the dashboard's inline scripts. If any block has a syntax
 * error, repair by replacing the canonical `tailwind.config` block from
 * the template (which is the only block known to be a recurring
 * regeneration target). Writes the file back if repaired.
 *
 * @param {string} dashboardPath - absolute path to dashboard HTML
 * @param {string} templatePath - absolute path to templates/dashboard.html
 * @returns {Promise<{ok: boolean, repaired: boolean, reason?: string}>}
 */
async function validateAndRepairDashboard(dashboardPath, templatePath) {
  const html = await fs.readFile(dashboardPath, "utf8");
  const scripts = extractInlineScripts(html);

  const failures = scripts
    .map((s) => ({ ...s, error: findSyntaxError(s.body) }))
    .filter((s) => s.error);

  if (failures.length === 0) {
    log("debug", "Dashboard inline scripts all parse cleanly", {
      scriptCount: scripts.length,
    });
    return { ok: true, repaired: false };
  }

  log("warn", "Dashboard inline <script> has syntax error(s) - attempting repair", {
    failureCount: failures.length,
    firstError: failures[0].error.message,
  });

  const dashboardTailwindBlock = findTailwindConfigScript(html);
  if (!dashboardTailwindBlock) {
    log("warn", "Dashboard has no tailwind.config block to repair");
    return { ok: false, repaired: false, reason: "no-matching-block-in-dashboard" };
  }

  const template = await fs.readFile(templatePath, "utf8");
  const canonicalBlock = findTailwindConfigScript(template);
  if (!canonicalBlock) {
    log("warn", "Could not locate canonical tailwind.config block in template - skipping repair");
    return { ok: false, repaired: false, reason: "template-block-not-found" };
  }

  const corruptedBlockSyntaxError = findSyntaxError(dashboardTailwindBlock.body);
  if (!corruptedBlockSyntaxError) {
    log("warn", "Dashboard tailwind.config block parses cleanly; corruption is elsewhere - cannot auto-repair");
    return { ok: false, repaired: false, reason: "corruption-outside-tailwind-block" };
  }

  const repaired =
    html.slice(0, dashboardTailwindBlock.index) +
    canonicalBlock.full +
    html.slice(dashboardTailwindBlock.index + dashboardTailwindBlock.full.length);

  const remainingFailures = extractInlineScripts(repaired)
    .map((s) => ({ ...s, error: findSyntaxError(s.body) }))
    .filter((s) => s.error);

  if (remainingFailures.length > 0) {
    log("warn", "Repair did not eliminate all syntax errors", {
      remaining: remainingFailures.length,
      firstError: remainingFailures[0].error.message,
    });
    return { ok: false, repaired: false, reason: "repair-incomplete" };
  }

  await fs.writeFile(dashboardPath, repaired);
  log("info", "Dashboard tailwind.config block repaired from template", {
    dashboardPath,
  });
  return { ok: true, repaired: true };
}

module.exports = {
  validateAndRepairDashboard,
  extractInlineScripts,
  findTailwindConfigScript,
  findSyntaxError,
};
