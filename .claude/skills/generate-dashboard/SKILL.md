---
name: generate-dashboard
description: Generate an HTML dashboard from meeting analysis. Use when the user wants to create a visual summary, build a dashboard, generate a report, or visualize meeting insights.
---

# Generate Meeting Dashboard

Create a beautiful HTML dashboard from meeting analysis.

## Instructions

1. Read the analysis from `projects/{project}/analysis/{date}.json`
   - If analysis doesn't exist, run the analyze-meeting skill first
2. Use the template from `templates/dashboard.html` as a base
3. Generate a complete, standalone HTML file with:
   - Modern, clean design using Tailwind CSS (via CDN)
   - All extracted insights organized in visual cards
   - Responsive layout for desktop and mobile
   - Print-friendly styling
   - The project name and date prominently displayed

4. Replace template placeholders with actual content:
   - `{{PROJECT_NAME}}` → Project display name (convert kebab-case to Title Case)
   - `{{DATE}}` → Meeting date formatted nicely
   - `{{MEETING_TYPE}}` → Type of meeting (standup, sprint review, etc.)
   - `{{SUMMARY}}` → Meeting summary paragraph
   - `{{ATTENDEES}}` → HTML list items for each attendee
   - `{{KEY_TOPICS}}` → HTML list items for topics
   - `{{KEY_DECISIONS}}` → HTML list items for top 1-3 decisions made (do not repeat in Done This Sprint)
   - `{{DONE_THIS_SPRINT}}` → HTML list items for outcomes, features completed (excluding decisions)
   - `{{NEXT_STEPS}}` → HTML cards for each action item with owner/deadline
   - `{{QUESTIONS}}` → HTML list items for open questions

5. **DEDUPLICATION CHECK** before saving:
   - For each piece of content, verify it appears in ONLY ONE tab
   - Overview summary = factual bullets only (no analysis/commentary)
   - Overview hard truths = max 2 items, only cross-cutting synthesis not in other tabs
   - Insights = ALL risks, elephants, hard truths, patterns (each topic appears ONCE)
   - If the same topic appears in both Overview hard truths AND Insights, REMOVE it from Overview
   - Use "(See Insights tab)" cross-references instead of repeating content

5. Save the dashboard to `projects/{project}/dashboards/{date}/index.html`

## Output

Confirm the dashboard location and provide a brief preview of what was generated.
