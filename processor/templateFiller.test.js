const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const { extractPlaceholderNames, fillDashboardTemplate, readFragment } = require("./templateFiller");

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
});
