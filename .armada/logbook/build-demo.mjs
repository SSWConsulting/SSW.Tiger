/**
 * Build the logbook demo site for the per-project index page feature.
 *
 * Renders the new project index (processor/projectIndex.js) with sample
 * meeting data, plus one filled-in meeting dashboard so the walkthrough
 * can click through from the index to a real-looking dashboard.
 *
 * Output: .armada/logbook/demo-site/yakshaver/...
 */

import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SITE = path.join(__dirname, "demo-site");

const { renderProjectIndex } = require(path.join(ROOT, "processor", "projectIndex.js"));

const meetings = [
  {
    meetingId: "2026-06-04-sprint-review",
    meetingDate: "2026-06-04",
    metadata: { totalDurationMinutes: 62, participantCount: 8, actionItemsCount: 5 },
  },
  {
    meetingId: "2026-05-28-sprint-review",
    meetingDate: "2026-05-28",
    metadata: { totalDurationMinutes: 48, participantCount: 6, actionItemsCount: 3 },
  },
  {
    meetingId: "2026-05-21-sprint-review",
    meetingDate: "2026-05-21",
    metadata: { totalDurationMinutes: 55, participantCount: 7, actionItemsCount: 4 },
  },
  {
    meetingId: "2026-05-14-sprint-review",
    meetingDate: "2026-05-14",
    metadata: { totalDurationMinutes: 41, participantCount: 6, actionItemsCount: 2 },
  },
];

// Browser-style address bar so the walkthrough shows where each page lives.
// Inline styles only — it is injected before Tailwind processes the page.
const urlBar = (urlPath) => `
<div style="position:sticky;top:0;z-index:50;background:#E8EAED;padding:8px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 1px 2px rgba(0,0,0,.08)">
    <div style="display:flex;gap:6px">
        <span style="width:11px;height:11px;border-radius:50%;background:#FF5F57"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#FEBC2E"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#28C840"></span>
    </div>
    <div id="demo-url-bar" style="flex:1;max-width:620px;background:#fff;border-radius:999px;padding:6px 16px;font-size:14px;color:#3F3F46;display:flex;align-items:center;gap:8px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="#71717A"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z"/></svg>
        <span style="color:#A1A1AA">https://</span><span>dashboards.sswtiger.com${urlPath}</span>
    </div>
</div>`;
const injectUrlBar = (html, urlPath) => html.replace(/(<body[^>]*>)/, `$1${urlBar(urlPath)}`);

// --- Project index page (the feature under demo) ---
const indexTemplate = await readFile(path.join(ROOT, "templates", "project-index.html"), "utf-8");
const indexHtml = injectUrlBar(
  renderProjectIndex({
    template: indexTemplate,
    displayName: "YakShaver",
    meetings,
    generatedAt: "2026-06-11",
  }),
  "/yakshaver/",
);
await mkdir(path.join(SITE, "yakshaver"), { recursive: true });
await writeFile(path.join(SITE, "yakshaver", "index.html"), indexHtml, "utf-8");

// --- One sample meeting dashboard, for the click-through chapter ---
const li = (items) => items.map((t) => `<li>• ${t}</li>`).join("\n");
const stat = (value, label) =>
  `<div class="bg-white rounded-lg p-4 ssw-card text-center"><p class="text-2xl font-bold text-ssw-red">${value}</p><p class="text-sm text-ssw-gray-500 font-medium">${label}</p></div>`;

const fills = {
  PROJECT_NAME: "YakShaver",
  DATE: "04/06/2026",
  MEETING_TYPE: "Sprint Review",
  DURATION: "62 min",
  GENERATED_AT: "Generated 11/06/2026",
  QUICK_STATS: [
    stat("62", "Minutes"),
    stat("8", "Participants"),
    stat("5", "Action Items"),
    stat("12", "PBIs Delivered"),
  ].join("\n"),
  SUMMARY: li([
    "Sprint 98 delivered 34 points across 12 PBIs",
    "New report builder demoed end-to-end",
    "Sprint 99 goal set: ship the report builder to beta users",
  ]),
  KEY_DECISIONS: li([
    "✅ YakShaver - Ship the report builder behind a feature flag",
    "✅ YakShaver - Move beta feedback review to a weekly cadence",
  ]),
  DONE_THIS_SPRINT: li([
    "YakShaver - Report builder UI completed (Alex)",
    "YakShaver - Export to PDF and Excel finished (Sam)",
    "YakShaver - Onboarding flow polished after user testing (Mia)",
  ]),
  NEXT_STEPS: li([
    "➡️ YakShaver - Enable the report builder for beta users (Alex)",
    "➡️ YakShaver - Collect structured beta feedback (Mia)",
  ]),
  HARD_TRUTHS: `<p>⚠️ 2 of 5 action items from the last sprint were carried over without an owner.</p>`,
};

let dashboardHtml = await readFile(path.join(ROOT, "templates", "dashboard.html"), "utf-8");
for (const [key, value] of Object.entries(fills)) {
  dashboardHtml = dashboardHtml.replaceAll(`{{${key}}}`, value);
}
// Blank out everything the demo doesn't need (other tabs' content)
dashboardHtml = dashboardHtml.replace(/\{\{[A-Z_]+\}\}/g, "");
dashboardHtml = injectUrlBar(dashboardHtml, "/yakshaver/2026-06-04-sprint-review/");

await mkdir(path.join(SITE, "yakshaver", "2026-06-04-sprint-review"), { recursive: true });
await writeFile(path.join(SITE, "yakshaver", "2026-06-04-sprint-review", "index.html"), dashboardHtml, "utf-8");

console.log(`Demo site built at ${SITE}`);
