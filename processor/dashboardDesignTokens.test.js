/**
 * Pins the SSW Design System radius/shadow/typography tokens ported into
 * the dashboard templates, alongside dashboardColorTokens.test.js which
 * pins the color tokens. Guards against silent drift back to the old
 * generic Tailwind rounded-xl/shadow-sm/text-3xl values.
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

function readTemplate(templatePath) {
  return fs.readFileSync(templatePath, "utf8");
}

function extractTailwindTheme(html) {
  const block = findTailwindConfigScript(html);
  assert.ok(block, "expected a tailwind.config script block");

  const sandbox = { tailwind: {} };
  vm.createContext(sandbox);
  vm.runInContext(block.body, sandbox);
  return sandbox.tailwind.config.theme.extend;
}

describe("dashboard template design tokens", () => {
  for (const templatePath of TEMPLATES) {
    const label = path.basename(templatePath);

    it(`${label}: fontSize scale is pinned to the SSW Design System h1-h4 tokens`, () => {
      const html = readTemplate(templatePath);
      const extend = extractTailwindTheme(html);
      // SSW.DesignSystem src/styles/theme.css --font-size-h1..h4 / --line-height-h1..h4
      assert.equal(extend.fontSize.h1[0], "40px");
      assert.equal(extend.fontSize.h1[1].lineHeight, "48px");
      assert.equal(extend.fontSize.h1[1].letterSpacing, "-0.5px");
      assert.equal(extend.fontSize.h2[0], "32px");
      assert.equal(extend.fontSize.h2[1].lineHeight, "40px");
      assert.equal(extend.fontSize.h3[0], "24px");
      assert.equal(extend.fontSize.h3[1].lineHeight, "32px");
      assert.equal(extend.fontSize.h4[0], "20px");
      assert.equal(extend.fontSize.h4[1].lineHeight, "28px");
    });

    it(`${label}: page title uses the h2 typography token (32px), not the old ad hoc text-3xl (30px)`, () => {
      const html = readTemplate(templatePath);
      assert.match(html, /<h1 class="text-h2 text-ssw-charcoal">/);
      assert.doesNotMatch(html, /<h1 class="text-3xl text-ssw-charcoal">/);
    });

    it(`${label}: card-level radius uses rounded-lg (design system --radius-lg, 8px), not rounded-xl (12px)`, () => {
      const html = readTemplate(templatePath);
      assert.doesNotMatch(html, /rounded-xl/);
      assert.doesNotMatch(html, /rounded-r-xl/);
    });

    it(`${label}: rounded-full (avatars/pills/dots) is left untouched as a shape choice, not a radius token`, () => {
      const html = readTemplate(templatePath);
      // Sanity check the audit didn't accidentally sweep up rounded-full too.
      const hasRoundedFull = /rounded-full/.test(html);
      assert.equal(hasRoundedFull, templatePath.includes("dashboard.html"));
    });

    it(`${label}: elevated cards use the --shadow-raised literal box-shadow value, not generic shadow-sm`, () => {
      const html = readTemplate(templatePath);
      assert.doesNotMatch(html, /shadow-sm/);
      assert.match(
        html,
        /\.shadow-raised\s*\{\s*box-shadow:\s*0px 2px 4px 0px rgba\(0, 0, 0, 0\.08\), 0px 4px 8px 0px rgba\(0, 0, 0, 0\.04\);\s*\}/,
      );
    });
  }
});

describe("processor/projectIndex.js generated meeting cards match the template's design tokens", () => {
  it("renders meeting cards with rounded-lg and shadow-raised, matching project-index.html's card CSS", () => {
    const jsPath = path.join(__dirname, "projectIndex.js");
    const js = fs.readFileSync(jsPath, "utf8");
    assert.match(js, /rounded-lg shadow-raised ssw-card/);
    assert.doesNotMatch(js, /rounded-xl/);
    assert.doesNotMatch(js, /shadow-sm/);
  });
});
