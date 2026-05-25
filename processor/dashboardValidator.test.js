const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const {
  validateAndRepairDashboard,
  extractInlineScripts,
  findTailwindConfigScript,
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

// Real-world corruption from dashboard 2026-05-25-123654 - the leading
// quote on 'sans-serif' was dropped. This parses cleanly as JavaScript
// (the parser reads `sans-serif` as `sans - serif`), so PR #99's
// SyntaxError check missed it. It only fails at runtime with
// `ReferenceError: sans is not defined`.
const RUNTIME_FAIL_TAILWIND_BLOCK = `<script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        'ssw-red': { DEFAULT: '#CC4141' },
                        'ssw-charcoal': { DEFAULT: '#333333' },
                        'ssw-gray': { 50: '#FAFAFA' }
                    },
                    fontFamily: {
                        'sans': ['Inter', 'Helvetica Neue', 'Helvetica', sans-serif],
                    }
                }
            }
        }
    </script>`;

// Original bug shape from issue #98 - dropped leading quote AND kept the
// trailing one, which produces an unbalanced quote and a real SyntaxError.
const SYNTAX_FAIL_TAILWIND_BLOCK = `<script>
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

describe("findTailwindConfigScript", () => {
  it("finds the inline block that assigns tailwind.config", () => {
    const html = buildHtml(CANONICAL_TAILWIND_BLOCK);
    const block = findTailwindConfigScript(html);
    assert.ok(block);
    assert.match(block.body, /tailwind\.config\s*=/);
  });

  it("returns null when no tailwind.config block is present", () => {
    const html = `<html><body><script>var x = 1;</script></body></html>`;
    assert.equal(findTailwindConfigScript(html), null);
  });
});

describe("findSyntaxError", () => {
  it("returns null for valid JS", () => {
    assert.equal(findSyntaxError("var x = 1; x + 2;"), null);
  });

  it("returns null for valid JS that references undeclared free variables", () => {
    assert.equal(findSyntaxError("tailwind.config = { theme: {} };"), null);
  });

  it("returns a SyntaxError for unbalanced braces", () => {
    const err = findSyntaxError("var x = { foo: 1");
    assert.ok(err);
    assert.equal(err.name, "SyntaxError");
  });

  it("does NOT flag the runtime-only corruption (unquoted sans-serif)", () => {
    const body = RUNTIME_FAIL_TAILWIND_BLOCK.replace(/^<script>|<\/script>$/g, "");
    assert.equal(
      findSyntaxError(body),
      null,
      "unquoted sans-serif parses as `sans - serif`, so SyntaxError check cannot catch it - this is why the always-overwrite strategy is needed",
    );
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

  it("returns repaired=false and leaves the file untouched when block already matches template", async () => {
    const dashboardPath = path.join(tmpDir, "clean.html");
    const templatePath = path.join(tmpDir, "template.html");
    const cleanHtml = buildHtml(CANONICAL_TAILWIND_BLOCK);
    await fs.writeFile(dashboardPath, cleanHtml);
    await fs.writeFile(templatePath, cleanHtml);

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.deepEqual(result, { ok: true, repaired: false });

    const after = await fs.readFile(dashboardPath, "utf8");
    assert.equal(after, cleanHtml, "byte-identical dashboard must not be rewritten");
  });

  it("repairs the runtime-only corruption (unquoted sans-serif) that PR #99 missed", async () => {
    const dashboardPath = path.join(tmpDir, "runtime-fail.html");
    const templatePath = path.join(tmpDir, "template-runtime.html");
    const corruptHtml = buildHtml(RUNTIME_FAIL_TAILWIND_BLOCK);
    const cleanHtml = buildHtml(CANONICAL_TAILWIND_BLOCK);
    await fs.writeFile(dashboardPath, corruptHtml);
    await fs.writeFile(templatePath, cleanHtml);

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.deepEqual(result, { ok: true, repaired: true });

    const after = await fs.readFile(dashboardPath, "utf8");
    assert.match(after, /'sans-serif'/, "repaired file must contain quoted sans-serif");
    assert.doesNotMatch(after, /, sans-serif\]/, "unquoted sans-serif must be gone");
  });

  it("repairs the original SyntaxError corruption from issue #98", async () => {
    const dashboardPath = path.join(tmpDir, "syntax-fail.html");
    const templatePath = path.join(tmpDir, "template-syntax.html");
    const corruptHtml = buildHtml(SYNTAX_FAIL_TAILWIND_BLOCK);
    const cleanHtml = buildHtml(CANONICAL_TAILWIND_BLOCK);
    await fs.writeFile(dashboardPath, corruptHtml);
    await fs.writeFile(templatePath, cleanHtml);

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.deepEqual(result, { ok: true, repaired: true });

    const after = await fs.readFile(dashboardPath, "utf8");
    const block = findTailwindConfigScript(after);
    assert.equal(findSyntaxError(block.body), null);
  });

  it("repairs the tailwind block even when an unrelated script is also broken", async () => {
    const dashboardPath = path.join(tmpDir, "mixed-corruption.html");
    const templatePath = path.join(tmpDir, "template-mixed.html");
    const corruptHtml = `<!DOCTYPE html>
<html><head>
${RUNTIME_FAIL_TAILWIND_BLOCK}
</head><body>
<script>var broken = { foo: 1</script>
</body></html>`;
    await fs.writeFile(dashboardPath, corruptHtml);
    await fs.writeFile(templatePath, buildHtml(CANONICAL_TAILWIND_BLOCK));

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.deepEqual(result, { ok: true, repaired: true });

    const after = await fs.readFile(dashboardPath, "utf8");
    const tailwindBlock = findTailwindConfigScript(after);
    assert.match(tailwindBlock.body, /'sans-serif'/);
    assert.match(after, /var broken = \{ foo: 1/, "unrelated broken script is left intact (we have no canonical version for it)");
  });

  it("returns ok=false when the dashboard has no tailwind.config block at all", async () => {
    const dashboardPath = path.join(tmpDir, "no-tailwind.html");
    const templatePath = path.join(tmpDir, "template-no-tw.html");
    await fs.writeFile(dashboardPath, `<html><body><p>nothing here</p></body></html>`);
    await fs.writeFile(templatePath, buildHtml(CANONICAL_TAILWIND_BLOCK));

    const result = await validateAndRepairDashboard(dashboardPath, templatePath);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-tailwind-block-in-dashboard");
  });
});
