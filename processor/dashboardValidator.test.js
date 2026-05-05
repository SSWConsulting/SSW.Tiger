const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const {
  validateAndRepairDashboard,
  extractInlineScripts,
  findSyntaxError,
} = require("./dashboardValidator");

const CANONICAL_TAILWIND_BLOCK = `<script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        'ssw-red': { DEFAULT: '#CC4141' },
                        'ssw-charcoal': { DEFAULT: '#333333' },
                        'ssw-gray': { 50: '#FAFAFA' }
                    },
                    fontFamily: {
                        'sans': ['Inter', 'Helvetica Neue', 'Helvetica', 'sans-serif'],
                    }
                }
            }
        }
    </script>`;

const CORRUPTED_TAILWIND_BLOCK = `<script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        'ssw-red': { DEFAULT: '#CC4141' },
                        'ssw-charcoal': { DEFAULT: '#333333' },
                        'ssw-gray': { 50: '#FAFAFA' }
                    },
                    fontFamily: {
                        'sans': ['Inter', 'Helvetica Neue', 'Helvetica', sans-serif'],
                    }
                }
            }
        }
    </script>`;

function buildHtml(tailwindBlock) {
  return `<!DOCTYPE html>
<html><head>
<script src="https://cdn.tailwindcss.com"></script>
${tailwindBlock}
<style>body { font-family: 'Inter'; }</style>
</head><body>
<div class="bg-ssw-red text-ssw-charcoal">Hello</div>
<script>
  document.querySelector('.profile').addEventListener('click', () => {});
</script>
</body></html>`;
}

describe("extractInlineScripts", () => {
  it("returns inline script bodies and skips external <script src=...>", () => {
    const html = `<script src="https://cdn.example.com/x.js"></script><script>var x = 1;</script>`;
    const scripts = extractInlineScripts(html);
    assert.equal(scripts.length, 1);
    assert.match(scripts[0].body, /var x = 1/);
  });

  it("skips empty inline scripts", () => {
    const html = `<script>   </script><script>var x = 1;</script>`;
    const scripts = extractInlineScripts(html);
    assert.equal(scripts.length, 1);
  });

  it("captures multiple inline scripts in order", () => {
    const html = `<script>var a = 1;</script><script>var b = 2;</script>`;
    const scripts = extractInlineScripts(html);
    assert.equal(scripts.length, 2);
    assert.match(scripts[0].body, /var a/);
    assert.match(scripts[1].body, /var b/);
  });
});

describe("findSyntaxError", () => {
  it("returns null for valid JS", () => {
    assert.equal(findSyntaxError("var x = 1; x + 2;"), null);
  });

  it("returns null for valid JS that references undeclared free variables", () => {
    assert.equal(findSyntaxError("tailwind.config = { theme: {} };"), null);
  });

  it("returns null for the canonical tailwind.config block body", () => {
    const body = CANONICAL_TAILWIND_BLOCK.replace(/^<script>|<\/script>$/g, "");
    assert.equal(findSyntaxError(body), null);
  });

  it("returns a SyntaxError for the corrupted sans-serif typo", () => {
    const body = CORRUPTED_TAILWIND_BLOCK.replace(/^<script>|<\/script>$/g, "");
    const err = findSyntaxError(body);
    assert.ok(err, "expected a syntax error");
    assert.equal(err.name, "SyntaxError");
  });

  it("returns a SyntaxError for unbalanced braces", () => {
    const err = findSyntaxError("var x = { foo: 1");
    assert.ok(err);
    assert.equal(err.name, "SyntaxError");
  });
});

describe("validateAndRepairDashboard", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-dashboard-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ok=true, repaired=false for a clean dashboard", async () => {
    const dashboardPath = path.join(tmpDir, "clean.html");
    const templatePath = path.join(tmpDir, "template.html");
    const cleanHtml = buildHtml(CANONICAL_TAILWIND_BLOCK);
    await fs.writeFile(dashboardPath, cleanHtml);
    await fs.writeFile(templatePath, cleanHtml);

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.deepEqual(result, { ok: true, repaired: false });

    const after = await fs.readFile(dashboardPath, "utf8");
    assert.equal(after, cleanHtml, "clean dashboard must not be rewritten");
  });

  it("repairs a dashboard with a corrupted tailwind.config block", async () => {
    const dashboardPath = path.join(tmpDir, "corrupt.html");
    const templatePath = path.join(tmpDir, "template-corrupt.html");
    const corruptHtml = buildHtml(CORRUPTED_TAILWIND_BLOCK);
    const cleanHtml = buildHtml(CANONICAL_TAILWIND_BLOCK);
    await fs.writeFile(dashboardPath, corruptHtml);
    await fs.writeFile(templatePath, cleanHtml);

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.equal(result.ok, true);
    assert.equal(result.repaired, true);

    const after = await fs.readFile(dashboardPath, "utf8");
    assert.match(after, /'sans-serif'/, "repaired file must contain quoted sans-serif");
    assert.doesNotMatch(after, /, sans-serif']/, "corruption must be gone");

    const scripts = extractInlineScripts(after);
    for (const s of scripts) {
      assert.equal(findSyntaxError(s.body), null, "all scripts must parse after repair");
    }
  });

  it("returns ok=false when corruption is outside the tailwind.config block", async () => {
    const dashboardPath = path.join(tmpDir, "other-error.html");
    const templatePath = path.join(tmpDir, "template-other.html");
    const otherCorruption = `<!DOCTYPE html>
<html><head>
${CANONICAL_TAILWIND_BLOCK}
</head><body>
<script>
  var broken = { foo: 1
</script>
</body></html>`;
    const cleanHtml = buildHtml(CANONICAL_TAILWIND_BLOCK);
    await fs.writeFile(dashboardPath, otherCorruption);
    await fs.writeFile(templatePath, cleanHtml);

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.equal(result.ok, false);
    assert.equal(result.repaired, false);
    assert.equal(result.reason, "corruption-outside-tailwind-block");
  });
});
