/**
 * Pins the SSW Design System color tokens ported into the dashboard
 * templates' inline tailwind.config blocks. Guards against silent drift:
 * dashboardValidator.test.js only exercises synthetic fixtures, so nothing
 * else in the suite reads the real templates and checks their color values.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const { findTailwindConfigScript } = require("./dashboardValidator");

const TEMPLATES = [
  path.join(__dirname, "..", "templates", "dashboard.html"),
  path.join(__dirname, "..", "templates", "project-index.html"),
];

function extractTailwindColors(templatePath) {
  const html = fs.readFileSync(templatePath, "utf8");
  const block = findTailwindConfigScript(html);
  assert.ok(block, `expected a tailwind.config script block in ${templatePath}`);

  const sandbox = { tailwind: {} };
  vm.createContext(sandbox);
  vm.runInContext(block.body, sandbox);
  return sandbox.tailwind.config.theme.extend.colors;
}

describe("dashboard template color tokens", () => {
  for (const templatePath of TEMPLATES) {
    const label = path.basename(templatePath);

    it(`${label}: ssw-red is pinned to the SSW Design System --primary token`, () => {
      const colors = extractTailwindColors(templatePath);
      // #CD4242 = hsla(0, 58%, 53%, 1), SSW.DesignSystem src/styles/theme.css --primary
      assert.equal(colors["ssw-red"].DEFAULT, "#CD4242");
      assert.equal(colors["ssw-red"][500], "#CD4242");
    });

    it(`${label}: ssw-charcoal is pinned to the SSW Design System --secondary token`, () => {
      const colors = extractTailwindColors(templatePath);
      // #333333 = hsla(0, 0%, 20%, 1), SSW.DesignSystem src/styles/theme.css --secondary
      assert.equal(colors["ssw-charcoal"].DEFAULT, "#333333");
      assert.equal(colors["ssw-charcoal"][700], "#333333");
    });

    it(`${label}: ssw-gray-100/200 are pinned to the SSW Design System's opacity-based neutral tokens`, () => {
      const colors = extractTailwindColors(templatePath);
      // #F5F5F5 = --fill-weak rgba(0,0,0,0.04) over white
      assert.equal(colors["ssw-gray"][100], "#F5F5F5");
      // #E6E6E6 = --stroke-weak rgba(0,0,0,0.1) over white
      assert.equal(colors["ssw-gray"][200], "#E6E6E6");
    });
  }
});
