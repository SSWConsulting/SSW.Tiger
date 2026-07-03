const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const {
  extractPlaceholderNames,
  fillDashboardTemplate,
  readFragment,
  formatGeneratedAt,
  DETERMINISTIC_PLACEHOLDERS,
} = require("./templateFiller");

const SAMPLE_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
    <title>{{PROJECT_NAME}} - {{DATE}}</title>
    <script>
        // Static chrome - never touched by the model
        tailwind.config = {
            theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'] } } }
        };
    </script>
</head>
<body>
    <h1>{{PROJECT_NAME}}</h1>
    <section>{{SUMMARY}}</section>
    <section>{{HARD_TRUTHS}}</section>
    <script>
        const sswColors = { red: '#CC4141' };
        {{CHART_SCRIPTS}}
    </script>
</body>
</html>`;

describe("extractPlaceholderNames", () => {
  it("returns the unique set of placeholder names in first-seen order", () => {
    const names = extractPlaceholderNames(SAMPLE_TEMPLATE);
    assert.deepEqual(names, ["PROJECT_NAME", "DATE", "SUMMARY", "HARD_TRUTHS", "CHART_SCRIPTS"]);
  });

  it("returns an empty array when there are no placeholders", () => {
    assert.deepEqual(extractPlaceholderNames("<html><body>no placeholders</body></html>"), []);
  });
});

describe("readFragment", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-fragment-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the fragment file's content when it exists", async () => {
    await fs.writeFile(path.join(tmpDir, "SUMMARY.html"), "<li>Did the thing</li>");
    const value = await readFragment(tmpDir, "SUMMARY");
    assert.equal(value, "<li>Did the thing</li>");
  });

  it("returns an empty string when the fragment file is missing", async () => {
    const value = await readFragment(tmpDir, "DOES_NOT_EXIST");
    assert.equal(value, "");
  });

  it("strips a wrapping markdown code fence if the model wrote one despite being told not to", async () => {
    await fs.writeFile(path.join(tmpDir, "FENCED.html"), "```html\n<li>Fenced content</li>\n```");
    const value = await readFragment(tmpDir, "FENCED");
    assert.equal(value, "<li>Fenced content</li>");
  });

  it("leaves unfenced content untouched", async () => {
    await fs.writeFile(path.join(tmpDir, "PLAIN.html"), "<li>Plain content</li>");
    const value = await readFragment(tmpDir, "PLAIN");
    assert.equal(value, "<li>Plain content</li>");
  });
});

describe("formatGeneratedAt", () => {
  it("formats a date as DD/MM/YYYY HH:MM, per CLAUDE.md's date convention", () => {
    const date = new Date(2026, 6, 3, 9, 5); // 3 July 2026, 09:05 (local)
    assert.equal(formatGeneratedAt(date), "Generated 03/07/2026 09:05");
  });
});

describe("DETERMINISTIC_PLACEHOLDERS", () => {
  it("marks GENERATED_AT as deterministic metadata, never model-authored", () => {
    assert.ok(DETERMINISTIC_PLACEHOLDERS.has("GENERATED_AT"));
  });
});

describe("fillDashboardTemplate", () => {
  let tmpDir;
  let templatePath;
  let fragmentsDir;
  let outputPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-fill-test-"));
    templatePath = path.join(tmpDir, "template.html");
    fragmentsDir = path.join(tmpDir, "dashboard-parts");
    outputPath = path.join(tmpDir, "dashboard", "index.html");
    await fs.writeFile(templatePath, SAMPLE_TEMPLATE);
    await fs.mkdir(fragmentsDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("substitutes every occurrence of a placeholder that appears more than once", async () => {
    await fs.writeFile(path.join(fragmentsDir, "PROJECT_NAME.html"), "YakShaver");
    await fs.writeFile(path.join(fragmentsDir, "DATE.html"), "03/07/2026");
    await fs.writeFile(path.join(fragmentsDir, "SUMMARY.html"), "<li>Sprint delivered</li>");
    await fs.writeFile(path.join(fragmentsDir, "HARD_TRUTHS.html"), "<p>None</p>");
    await fs.writeFile(path.join(fragmentsDir, "CHART_SCRIPTS.html"), "console.log('chart');");

    const result = await fillDashboardTemplate({ templatePath, fragmentsDir, outputPath });
    const html = await fs.readFile(outputPath, "utf-8");

    assert.equal((html.match(/YakShaver/g) || []).length, 2, "PROJECT_NAME appears twice in the template");
    assert.match(html, /<title>YakShaver - 03\/07\/2026<\/title>/);
    assert.match(html, /<li>Sprint delivered<\/li>/);
    assert.match(html, /console\.log\('chart'\);/);
    assert.deepEqual(result.placeholders.sort(), ["CHART_SCRIPTS", "DATE", "HARD_TRUTHS", "PROJECT_NAME", "SUMMARY"].sort());
  });

  it("leaves static chrome outside placeholder regions byte-identical to the template", async () => {
    await fillDashboardTemplate({ templatePath, fragmentsDir, outputPath });
    const html = await fs.readFile(outputPath, "utf-8");

    assert.match(html, /tailwind\.config = \{/);
    assert.match(html, /fontFamily: \{ sans: \['Inter', 'sans-serif'\] \}/);
    assert.match(html, /const sswColors = \{ red: '#CC4141' \};/);
  });

  it("degrades a missing fragment to an empty string instead of throwing", async () => {
    // Deliberately do not write a fragment for HARD_TRUTHS this time.
    await fs.rm(path.join(fragmentsDir, "HARD_TRUTHS.html"), { force: true });
    await fs.writeFile(path.join(fragmentsDir, "PROJECT_NAME.html"), "YakShaver");
    await fs.writeFile(path.join(fragmentsDir, "DATE.html"), "03/07/2026");
    await fs.writeFile(path.join(fragmentsDir, "SUMMARY.html"), "<li>Sprint delivered</li>");
    await fs.writeFile(path.join(fragmentsDir, "CHART_SCRIPTS.html"), "");

    const html = await fs.readFile(outputPath, "utf-8").catch(() => null);
    await assert.doesNotReject(() => fillDashboardTemplate({ templatePath, fragmentsDir, outputPath }));

    const result = await fs.readFile(outputPath, "utf-8");
    assert.doesNotMatch(result, /\{\{HARD_TRUTHS\}\}/, "placeholder must not remain literally in the output");
  });

  it("produces byte-identical output across repeated runs for the same inputs", async () => {
    const first = await fillDashboardTemplate({ templatePath, fragmentsDir, outputPath });
    const firstHtml = await fs.readFile(outputPath, "utf-8");
    const second = await fillDashboardTemplate({ templatePath, fragmentsDir, outputPath });
    const secondHtml = await fs.readFile(outputPath, "utf-8");

    assert.equal(firstHtml, secondHtml);
    assert.deepEqual(first.placeholders, second.placeholders);
  });

  it("does not let a fragment's literal placeholder-like text get re-substituted (single-pass substitution)", async () => {
    // SUMMARY's own content literally contains another placeholder's token -
    // a naive per-placeholder split/join loop would substitute it a second
    // time when it got to HARD_TRUTHS; a single-pass substitution must not.
    await fs.writeFile(path.join(fragmentsDir, "PROJECT_NAME.html"), "YakShaver");
    await fs.writeFile(path.join(fragmentsDir, "DATE.html"), "03/07/2026");
    await fs.writeFile(path.join(fragmentsDir, "SUMMARY.html"), "<li>Discussed the {{HARD_TRUTHS}} token literally</li>");
    await fs.writeFile(path.join(fragmentsDir, "HARD_TRUTHS.html"), "<p>Real hard truth</p>");
    await fs.writeFile(path.join(fragmentsDir, "CHART_SCRIPTS.html"), "");

    await fillDashboardTemplate({ templatePath, fragmentsDir, outputPath });
    const html = await fs.readFile(outputPath, "utf-8");

    assert.match(html, /Discussed the \{\{HARD_TRUTHS\}\} token literally/, "the literal token in SUMMARY must survive untouched");
    assert.match(html, /<p>Real hard truth<\/p>/, "the real HARD_TRUTHS placeholder must still be substituted");
  });

  it("fills GENERATED_AT deterministically and ignores any fragment file for it", async () => {
    const templateWithGeneratedAt = SAMPLE_TEMPLATE.replace(
      "</body>",
      '    <footer>{{GENERATED_AT}}</footer>\n</body>',
    );
    const genTemplatePath = path.join(tmpDir, "template-with-generated-at.html");
    await fs.writeFile(genTemplatePath, templateWithGeneratedAt);

    // Deliberately write a fragment for GENERATED_AT - it must be ignored,
    // since the model is instructed never to author this placeholder.
    await fs.writeFile(path.join(fragmentsDir, "GENERATED_AT.html"), "the model's guess at the time");
    await fs.writeFile(path.join(fragmentsDir, "PROJECT_NAME.html"), "YakShaver");
    await fs.writeFile(path.join(fragmentsDir, "DATE.html"), "03/07/2026");
    await fs.writeFile(path.join(fragmentsDir, "SUMMARY.html"), "<li>Sprint delivered</li>");
    await fs.writeFile(path.join(fragmentsDir, "HARD_TRUTHS.html"), "<p>None</p>");
    await fs.writeFile(path.join(fragmentsDir, "CHART_SCRIPTS.html"), "");

    const result = await fillDashboardTemplate({
      templatePath: genTemplatePath,
      fragmentsDir,
      outputPath,
    });
    const html = await fs.readFile(outputPath, "utf-8");

    assert.doesNotMatch(html, /the model's guess at the time/, "GENERATED_AT must never come from a model-authored fragment");
    assert.match(html, /<footer>Generated \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}<\/footer>/);
    assert.ok(result.placeholders.includes("GENERATED_AT"));
  });
});
