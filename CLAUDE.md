# Meeting Summary Dashboard Generator

You are a meeting transcript processor. Your job is to convert .vtt transcripts into **comprehensive, multi-tab HTML dashboards** and deploy them to Azure Blob Storage (served via sswtiger.com).

## CRITICAL RULES

1. **NEVER create markdown files** - Only create HTML dashboards
2. **NEVER just summarize** - Always generate a FULL multi-tab dashboard
3. **ALWAYS use the specialized agents** for deep analysis
4. **ALWAYS run consolidation** before generating the dashboard
5. **ALWAYS deploy to Azure Blob Storage** after generating the dashboard
6. **PUT SERIOUS EFFORT INTO THIS** - This is important work

## Architecture

### Specialized Analysis Agents (in `.claude/agents/`)

| Agent | Purpose | Output |
|-------|---------|--------|
| `timeline-analyzer` | Identify meeting segments, phases, flow | `analysis/timeline.json` |
| `people-analyzer` | Analyze contributions, roles, provide feedback | `analysis/people.json` |
| `insights-generator` | Find non-obvious patterns, risks, opportunities | `analysis/insights.json` |
| `analytics-generator` | Generate data-driven metrics and statistics | `analysis/analytics.json` |
| `longitudinal-analyzer` | Compare with historical data, track trends | `analysis/longitudinal.json` |
| **`consolidator`** | **Harmonize all outputs, ensure consistency** | **`analysis/consolidated.json`** |

### Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                        1. SETUP                                  │
│  Create folders, copy transcript                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    2. PARALLEL ANALYSIS                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Timeline │ │ People   │ │ Insights │ │Analytics │ │ Trends │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
└───────┼────────────┼────────────┼────────────┼───────────┼──────┘
        ↓            ↓            ↓            ↓           ↓
┌─────────────────────────────────────────────────────────────────┐
│                    3. CONSOLIDATION                              │
│  • Normalize names (Alice, not "Product Owner")                 │
│  • Cross-reference data between agents                          │
│  • Deduplicate insights and action items                        │
│  • Verify metric consistency                                    │
│  • Flag unresolved issues                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  4. GENERATE DASHBOARD FRAGMENTS                 │
│  Use consolidated.json (NOT raw agent outputs)                  │
│  One raw-HTML fragment per {{PLACEHOLDER}}, consistent naming    │
│  Write to: projects/{project}/{meeting-id}/dashboard-parts/      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
   (dashboard/index.html assembly + deployment handled by processor/index.js)
```

## Participant Resolution

When processing a transcript, you have two data sources for identifying participants:

1. **VTT `<v>` speaker tags** (e.g., `<v Tiago Araujo [SSW]>...`) — these are **authoritative**. Always use them, even if the person is not on the invite list.
2. **Attendees file** (`attendees.json` in the meeting folder) — this contains the meeting invite list with names derived from UPNs. Use it as a **suggestion** for resolving names from transcript text, NOT as a source of truth for who attended.

### Resolution Priority

1. **`<v>` tags always win** — if someone has speaker tags, use their tagged name as canonical. This applies even if they are not on the invite list.
2. **Invite list for name resolution** — when the transcript text mentions someone by name (e.g., "Gryphon", "Alex") but they have no `<v>` tag, match against the invite list for:
   - **Spelling correction**: "Gryphon" → "Griffen Edge", "Thiago" → "Tiago Araujo"
   - **First-name-to-full-name expansion**: "Alex" → "Alex Blum" (from UPN `AlexBlum@ssw.com.au`). Even when the first name is already spelled correctly, always look up the **full derived name** from the invitees list. With a small invite list of 6-10 people, a first-name match is almost always the right person.
3. **Unknown speakers** — if a name appears in transcript text but has no `<v>` tag and no plausible invite list match, do NOT create a participant card for them. They are likely being referenced in conversation but were not actually in the meeting.

### Who Gets a Participant Card

Only create participant cards for people who meet **at least one** of these criteria:
1. They have `<v>` speaker tags in the VTT (they were on their own device)
2. They are on the invite list AND are mentioned in the transcript (they were likely in the boardroom)

People who are only **mentioned by name** in conversation but are NOT on the invite list and have no `<v>` tags do NOT get cards — they were being discussed, not attending. For example, if someone says "Willow suggested we do X", Willow does not get a participant card unless she has `<v>` tags or is on the invite list.

### Boardroom / Shared Device Handling

When a VTT transcript has some lines with `<v>` tags and some without, it means some participants joined on their own device while others were in a shared space (e.g., a boardroom). Check `attendees.json` for `vttInfo.hasSpeakerLabels` and `vttInfo.taggedSpeakers` to understand the mix.

**For the speaker timeline:**
- Speech from `<v>` tags → attribute to the named speaker as normal
- Speech WITHOUT `<v>` tags (shared device / boardroom) → attribute to **"Group"** as a single speaker entry
- Do **NOT** attempt to guess which individual in the group is speaking based on transcript content
- The timeline should honestly show entries like: `Group (Boardroom)`, `Tiago Araujo`, `Willow Lyu`

**For participant cards:**
- Participants with `<v>` tags → full analysis with speaking time, value score, feedback as normal
- Boardroom participants (known from invite list + transcript mentions, no `<v>` tags) → create cards with correct names and profile photos, but note that individual speaking time metrics are unavailable since they shared a device

## Consolidation Rules

The consolidator ensures:

### Name Consistency
- If someone is identified by name, use that name everywhere
- Don't say "Product Owner" in one tab and "Alice" in another
- Create a canonical name mapping and apply it throughout
- When resolving names, follow the priority order in the **Participant Resolution** section above

### Data Quality
- Resolve conflicting metrics between agents
- Merge duplicate action items
- Link decisions to timeline segments
- Connect insights to specific participants

### Cross-References
- Action items → Owner (by name)
- Decisions → Timeline segment where made
- Insights → Relevant participants
- Quotes → Speaker (by canonical name)

## Dashboard Requirements

The dashboard MUST have these tabs (all using consolidated data):

**Content rules:**
- DO NOT repeat the same point across multiple tabs. Each piece of information should appear in exactly one tab.
- Use whole numbers for all stats
- Avoid average marks like 7/10, be more decisive in your marking, giving 6/10 or 8/10
- If any particular ceremony is skipped (e.g., retro was deferred or not held), there is no need to mention or analyse it — just omit it
- Use Australian date format (DD/MM/YYYY) for all dates

**Number formatting (applies everywhere):**

Every numeric value the dashboard emits - in any field, in any tab, in any agent's prose - must be rendered as digits, not spelled out. This applies to counts, durations, points, scores, ratings, percentages, ratios, frequencies, time references, multipliers - all of them.

- Correct: `2 sprints of runway`, `3 action items`, `4 people dominated`, `18% of speaking time`, `2x as long`, `6/10`, `47.3%`
- Wrong: `two sprints of runway`, `three action items`, `four people dominated`, `eighteen percent of speaking time`, `twice as long`, `six out of ten`, `forty-seven point three percent`

**Two narrow exceptions** (preserve spelled-out form):

1. **Idiomatic phrases** where the word isn't really a count - `one of the team`, `for once`, `second to none`, `in two minds`, `on the one hand`. Leave these alone.
2. **Ordinals in proper nouns or section titles** - `First Sprint Review`, `Third Wednesday of the Month`. Leave these alone.

Transcript quotes are NOT an exception. If a speaker said "two sprints", paraphrase as `2 sprints` in any dashboard prose. Consistency in the dashboard output beats verbatim quote fidelity.

**Content deduplication (CRITICAL — allowlist approach):**

Each tab answers ONE question. Before writing content for any section, ask: "Which tab's question does this answer?" Put it there and NOWHERE else.

| Tab | The ONE Question It Answers | Owns exclusively |
|---|---|---|
| **Overview** | "What happened, what's done, and what's next?" | Factual summary, done items, next steps |
| **Timeline** | "When did things happen and how was time spent?" | Chronological flow, time allocation, pacing |
| **People** | "How did each individual contribute?" | Individual performance, feedback, person-specific issues |
| **Insights** | "What's hidden beneath the surface?" | Risks, elephants, patterns, opportunities, hard truths |
| **Trends** | "How does this compare to history and where is this heading?" | Historical comparison, trajectories, predictions |

For every piece of content, find the ONE tab whose question it answers best. If it could fit two tabs, pick the MORE SPECIFIC one (e.g., a person issue → People, not Overview). If you need to reference content from another tab, write "(See People tab)" instead of repeating it.

**Duplication anti-patterns (MUST AVOID):**

A single topic (e.g., "John departing") must NOT appear as:
- Overview summary bullet: "John announced departure" ← OK (factual)
- Overview hard truth: "No transition plan for John" ← DUPLICATE — this is an insight
- Timeline flow analysis: "John's transition plan missing from agenda" ← DUPLICATE of the same topic
- Insights risk radar: "Leadership vacuum" ← DUPLICATE of the same topic
- Insights elephants: "Nobody discussed succession" ← DUPLICATE of the same topic

**That's FIVE places for ONE topic — completely unacceptable.**

**Correct approach:** The factual event goes in Overview summary ("John announced departure to SSW AI team"). The analysis/commentary goes in Insights as ONE unified entry that combines the risk, elephant, and opportunity angles into a single paragraph. Timeline may note it briefly as a skipped topic in flow analysis but with NO analysis — just "(See Insights tab)". It does NOT appear in Overview hard truths.

**The "same topic" test:** If two items are about the same person + same event/issue, they are the SAME TOPIC regardless of the angle (risk vs. opportunity vs. elephant vs. missing agenda item). Merge them.

**Cross-tab duplication between Timeline and Insights (CRITICAL):**
"Missing agenda items" / "things not discussed" belong EXCLUSIVELY in the Insights tab (Elephants in the Room). The Timeline tab must NOT have a "Missing from Agenda" section at all. Timeline only covers what DID happen chronologically.

**Privacy rules:**
- **Client anonymization**: If client or company names are mentioned in the transcript, do NOT display them in the dashboard. Replace with "Client A", "Client B", "Client C", etc. SSW staff names are fine to show.

**Styling rules (SSW Design System - `ds-*` classes, real component source from `SSWConsulting/SSW.DesignSystem`):**

The template's static chrome already provides the card/badge/avatar/tab CSS (`.ds-card`, `.ds-badge-*`, `.ds-avatar`, `.speaker-*`, `.value-bar-*`). Every fragment you author must use these classes, NOT the old `bg-white rounded-xl shadow-sm ssw-card` / `bg-ssw-red-50` / `grade-a`..`grade-f` patterns from earlier dashboard versions.

- **Cards**: any self-contained content block (a participant card, a risk card, etc.) uses `class="ds-card"` with inner padding `px-4 pt-4` (top) and `px-4 pb-4` (bottom) - see the participant card example below. Do NOT use `rounded-xl`, `shadow-sm`, `ssw-card`, or raw `bg-white` on fragment content - the template's outer chrome already places most cards; you only need `ds-card` when a fragment itself introduces a new card-like block (e.g. one risk item, one participant).
- **Badges**: use `class="ds-badge ds-badge-<variant>"` instead of colored `bg-*-50` boxes. Variant mapping:
  | Variant | Usage |
  |---|---|
  | `ds-badge-success` | Positive/on-track indicators, opportunities, Done This Sprint style callouts |
  | `ds-badge-warning` | Caution items, elephants in the room |
  | `ds-badge-destructive` | Critical risks, Hard Truths |
  | `ds-badge-secondary` | Neutral info, e.g. a speaking-time percentage pill |
  | `ds-badge-outline` | Low-emphasis metadata (e.g. the header duration badge - already handled by template chrome) |
- Any other background color (`bg-blue-*`, `bg-purple-*`, `bg-indigo-*`, `bg-teal-*`, raw Tailwind `bg-green-50`/`bg-amber-50`/`bg-red-50`, `grade-a`..`grade-f`) is **forbidden**. `border-l-4` accent bands (e.g. People Strengths/Feedback) use inline `style="border-left: 3px solid var(--text-success)"` / `var(--text-warning)` with a matching `background: var(--fill-success-weak)` / `var(--fill-warning-weak)`, exactly as shown in the participant card example below - not Tailwind color utility classes.
- In warning/alert content (Hard Truths, Time Waste), keep the body text `color: var(--text-strong)` (black). Only the badge/heading uses the accent color.
- Icon usage by context:
  - ✅ for completed/positive items (Done This Sprint, Key Decisions)
  - ⚠️ for warnings, risks, caution items
  - ❌ for things that went wrong or failed — NEVER use ❌ in Next Steps (these are future plans, not failures)
  - ➡️ for all Next Steps items (they are forward-looking actions)
- **All Overview sections use the same format:** `<li>` bullet points inside `<ul>`. This applies to Summary, Key Decisions, Done This Sprint, and Next Steps. Do NOT use `<div>` card grids for these — keep them as clean bullet lists (the `<ul>`/`<li>` wrapper itself is already provided by the template chrome around each Overview card; your fragment is just the `<li>` items).

### Tab 1: Overview

All sections below use `<li>` bullet points inside `<ul>` — consistent style throughout.

- **Meeting Summary** — **brief** factual bullet points, max 5 bullets. Each bullet is one short sentence. No commentary or analysis. Example: `<li>Sprint 98 delivered 35 points across 12 PBIs</li>`
- **Key Decisions** — choices between alternatives, **max 3 bullets** (e.g., "Use SSW Identity Server instead of building from scratch"). Sprint goal setting is NOT a key decision — it belongs in the summary. Each bullet starts with `<Product> - ` (see `consolidator.md` > `Item product prefix`).
- **Done This Sprint** — outcomes, features completed/demoed, issues resolved. Each item as a plain `<li>` with owner in parentheses. No emoji icons. Do NOT repeat decisions already in Key Decisions. Each bullet starts with `<Product> - ` (see `consolidator.md` > `Item product prefix`).
- **Next Steps** — work items for next sprint and other follow-up actions, as plain `<li>` bullets with owner **(canonical names!)**. No emoji icons. Each bullet starts with `<Product> - ` (see `consolidator.md` > `Item product prefix`).
- **Hard truths** — **MAX 2 items, each max 2 sentences.** Keep them punchy and direct, not paragraph-length essays. ONLY high-level synthesis that genuinely doesn't fit in Insights, People, or Trends. The `{{HARD_TRUTHS}}` fragment is one or more rows, each a `<span class="ds-badge ds-badge-destructive">Hard truth</span>` badge followed by the sentence(s) - see the Hard Truths example under "Participant Cards" styling below for the badge+text row pattern.

### Tab 2: Timeline
- **Speaker Timeline Visualization** - Horizontal bars showing exactly when each person spoke (like Teams interface). See the `SPEAKER_TIMELINE` markup pattern below (`.speaker-row`/`.speaker-track`/`.speaker-seg`).
- Visual timeline with participants **(canonical names!)**
- **Boardroom handling**: If the VTT has a mix of `<v>`-tagged and untagged speech, show "Group (Boardroom)" as a speaker entry for all untagged speech. Do NOT guess individual speakers from untagged text.
- Duration and energy level for each
- Key moments highlighted
- Flow Analysis: transition quality and agenda adherence go in `{{FLOW_ANALYSIS}}`; the time waste inventory goes in the separate `{{TIME_WASTE_ANALYSIS}}` fragment (both render inside the same "Flow Analysis" card, one below the other - the template supplies the sub-heading for each, your fragment is just the content). Agenda adherence should render as a `ds-badge` (e.g. `ds-badge-success` "On track", `ds-badge-warning` "Behind schedule").
- Chronological segments (what happened, in order) go in `{{TIMELINE_SEGMENTS}}`, rendered in its own "Meeting Timeline" card below the Speaker Timeline / Flow Analysis row.
- **Do NOT include "Missing from Agenda" section** — that content belongs exclusively in the Insights tab (Elephants in the Room)

### Tab 3: People & Roles
- `{{TEAM_DYNAMICS}}` and `{{POWER_DYNAMICS}}` each render as their own flat `ds-card` above the participant grid (title supplied by the template chrome) - plain prose/short bullets, no gradient banner styling; the Design System has no gradient-hero token, so these are just ordinary cards now.
- Card for each participant **(canonical name with role as subtitle)**
- **Profile photo from SSW People** (with fallback for non-SSW participants)
- Speaking time vs. value contribution
- **Written feedback is the focus of each card.** Strengths and Feedback are the primary content, rendered as prominent coloured bands (green for Strengths, amber for Feedback - including the band heading) in larger text below the rating, NOT as small grey footnotes. Render each from the participant's `strengths[]` and `feedback[]` lists in `consolidated.json` (2-3 bullets each). Feedback is a bulleted list, not a single paragraph.
  - **Every bullet leads with a bold topic prefix** so the card is scannable at a glance, e.g. `<span class="font-semibold">Interruptions</span> - cut across others 5 times`. The prefix comes from the consolidated data (`<Topic> - point`); render only the text before the **first** ` - ` bold, leaving any later hyphens in the point unbolded. This mirrors the `<Product> -` prefix on Overview bullets.
  - Keep band body text `color: var(--text-strong)` (black); only the heading and left border use accent colours (`var(--text-success)` / `var(--text-warning)`) - see the participant card example below.
  - **Thin-feedback fallback:** render only the points that exist (1 is fine if that's all there is). If a participant has no strengths or no feedback at all (e.g. a boardroom attendee with minimal individual signal), omit that band entirely rather than render an empty coloured box.
- Value scores are whole numbers out of 10, no decimals. Avoid 7/10 (too average/non-committal); be more decisive with 6 or 8. Bar color via `.value-bar-fill` inline `background`: 8-10 = `var(--text-success)`, 4-6 = `var(--text-warning)`, 3 and below = `var(--text-error)`. **The rating/bar stays as-is - it is not de-emphasized, just no longer the only thing that stands out.**
- **Boardroom participants** (identified from invite list + transcript mentions, but no `<v>` tags): include cards with correct names/photos, but note that individual speaking metrics are unavailable

### Tab 4: Insights
- `{{TEAM_HEALTH}}` renders as its own flat `ds-card` at the top of the tab (title supplied by template chrome) - plain prose, no gradient banner.
- **This tab OWNS all analysis, risks, elephants, and hard truths.** If something is uncomfortable or hidden, it goes HERE, not in Overview.
- Each finding appears in ONE sub-section only (a topic is either a risk OR an elephant OR an opportunity — never all three)
- Risk signals with who raised them **(canonical names!)** — `{{RISK_RADAR}}` fragment, one `<span class="ds-badge ds-badge-destructive">Critical risk</span>` (or similarly worded) badge + text per finding, in its own grid card
- Elephants in the room — **each elephant is max 2-3 sentences**: what it is, why it matters, one-line recommendation. Do NOT write full paragraphs with background context. `{{ELEPHANTS}}` fragment uses `<span class="ds-badge ds-badge-warning">Elephant in the room</span>` badge + text per finding, in its own grid card.
- Buried opportunities — `{{INSIGHTS_CARDS}}` fragment uses `<span class="ds-badge ds-badge-success">Opportunity</span>` badge + text per finding, in its own grid card.
- Notable quotes **(attributed by canonical name!)** — `{{NOTABLE_MOMENTS}}` fragment, full-width card below the 3-card grid, each quote as `<p class="text-sm italic">"..." <span class="not-italic font-semibold">- Name</span></p>`.

### Tab 5: Trends
- Comparison with previous meetings
- Recurring themes — `{{RECURRING_ISSUES}}` fragment renders as a row of `<span class="ds-badge ds-badge-warning">Theme</span>` (or `ds-badge-outline` for lower-signal ones) pills, not a red "graveyard" warning box.
- Improvement tracking — `{{TRENDS_CONTENT}}` fragment is the entire "Value Score Trend" card body: a simple CSS bar visualization (styled `<div>`s with inline `height`/`width` percentages, one per historical sprint, most-recent bar tinted with `background: var(--text-success)`), plus a one-line summary of the trend in a `ds-card-footer`. No Chart.js - the Design System mockup this template is based on uses plain styled divs for this, and there is no `{{CHART_SCRIPTS}}` placeholder in this template (see below).
- `{{PREDICTIONS}}` fragment is the full-width "Prediction" card body - plain prose.

## Project Structure

```
projects/{project-name}/
├── 2026-01-22/                       # Self-contained meeting folder
│   ├── transcript.vtt                # Meeting transcript
│   ├── analysis/                     # Meeting-specific analysis
│   │   ├── timeline.json             # Raw agent output
│   │   ├── people.json               # Raw agent output
│   │   ├── insights.json             # Raw agent output
│   │   ├── analytics.json            # Raw agent output
│   │   ├── longitudinal.json         # Raw agent output
│   │   └── consolidated.json         # ← HARMONIZED - USE THIS FOR DASHBOARD
│   ├── dashboard-parts/              # ← YOU write one fragment file per placeholder here
│   │   ├── SUMMARY.html
│   │   ├── PARTICIPANT_CARDS.html
│   │   └── ...
│   └── dashboard/                    # Meeting dashboard
│       └── index.html                # Generated deterministically by processor/index.js - do NOT write this yourself
└── 2026-01-22-sprint-review/         # Another meeting (same day, different ID)
    ├── transcript.vtt
    ├── analysis/
    │   └── ...
    ├── dashboard-parts/
    │   └── ...
    └── dashboard/
        └── index.html
```

## Dashboard Generation

### IMPORTANT: You write fragments, not the final HTML

**You never write `dashboard/index.html` yourself.** `processor/index.js` reads `templates/dashboard.html` and deterministically substitutes each `{{PLACEHOLDER}}` with a fragment file you write - that is the only path the final HTML is produced through. This keeps the template's static chrome (SSW Design System tokens/CSS, the tab-switching script, the profile-image fallback script, page structure - everything that isn't a `{{PLACEHOLDER}}` region) out of your output entirely, so a typo you make can never corrupt it. See GitHub issue #125.

This template has **no `{{CHART_SCRIPTS}}` placeholder and loads no Chart.js** - it is built directly from the real SSW.DesignSystem component source (Card, Badge, Avatar, Tabs), which favours plain styled markup over chart libraries. The Trends tab's trend visualization (`{{TRENDS_CONTENT}}`) is authored as plain CSS bar `<div>`s, not JavaScript - see Tab 5 above.

1. Read the template file first: `templates/dashboard.html`, to see the current placeholder names and what each region is for.
2. For every `{{PLACEHOLDER}}` in the template (e.g. `{{PROJECT_NAME}}`, `{{DATE}}`, `{{SUMMARY}}`, `{{PARTICIPANT_CARDS}}`, ...) EXCEPT `{{GENERATED_AT}}`, write ONE fragment file containing that placeholder's content to:
   ```
   projects/{project}/{meeting-id}/dashboard-parts/{PLACEHOLDER_NAME}.html
   ```
3. Each fragment file contains ONLY the raw HTML for that region - no `<html>`/`<head>`/`<body>` wrapper, no markdown code fences.
4. If a section legitimately has nothing to show (e.g. a ceremony was skipped - see the content rule above), write an empty file rather than inventing content. A missing or empty fragment is substituted with an empty string, not an error - so omitting a section this way is always safe.
5. Do NOT create `projects/{project}/{meeting-id}/dashboard/index.html` yourself, and do NOT read or copy chrome (Design System tokens/CSS, tab script, the profile-image fallback script) into any fragment - that content lives solely in `templates/dashboard.html` and is never something you author.
6. Do NOT write a `GENERATED_AT.html` fragment. `{{GENERATED_AT}}` is deterministic metadata (the current timestamp) filled in automatically - you have no reliable notion of "now," so this one placeholder is never your job.

**DO NOT create a full dashboard HTML file from scratch - write fragments, one per placeholder!**

### Speaker Timeline Visualization

The `SPEAKER_TIMELINE.html` fragment (for the `{{SPEAKER_TIMELINE}}` placeholder) must be populated with HTML showing horizontal bars for each speaker, visualizing when they spoke throughout the meeting, using the Design System's `.speaker-row` / `.speaker-track` / `.speaker-seg` classes (real markup pattern, copied from the SSW.DesignSystem-based mockup - do NOT use the older `.speaker-timeline-row`/`.speaker-timeline-bar-container`/`.speaker-timeline-bar` classes, they no longer exist in this template).

Use data from `consolidated.json -> speakerTimeline -> participants[]` to generate:

```html
<div class="speaker-row">
    <span class="text-sm font-medium" style="color: var(--text-strong);">Alice</span>
    <div class="speaker-track">
        <!-- Each interval becomes a positioned bar. Alternate speakers between
             var(--primary) and var(--secondary); use var(--muted-foreground)
             for a "Group (Boardroom)" row. -->
        <div class="speaker-seg" style="left: 2.5%; width: 12.8%; background: var(--primary);"
             title="00:02:15-00:04:30 (2m 15s) - Sprint intro"></div>
        <div class="speaker-seg" style="left: 5.8%; width: 14.5%; background: var(--primary);"
             title="00:05:10-00:07:45 (2m 35s) - Feature demo setup"></div>
        <!-- ... more intervals ... -->
    </div>
    <span class="text-xs text-right" style="color: var(--text-weak);">27m 15s (27%)</span>
</div>
```

**Calculation:**
- `left = (intervalStart / meetingDuration) * 100%`
- `width = (intervalDuration / meetingDuration) * 100%`
- There is no `short`/`medium`/`long` segment-size class in this template (that distinction lived in the old `.speaker-timeline-bar` variants); a single `.speaker-seg` handles all interval lengths - vary only the `background` color per speaker as above.

**Sort participants by total speaking time (descending)**

### Participant Cards with Profile Photos

The `{{PARTICIPANT_CARDS}}` placeholder must be populated with HTML cards for each participant, including their SSW profile photo, using the Design System's `ds-card`/`ds-avatar`/`ds-badge`/`value-bar-*` classes (real markup pattern, copied from the SSW.DesignSystem-based mockup).

#### SSW Profile Photo URL Pattern

Profile photos are stored in the SSW.People.Profiles GitHub repository:

```
https://raw.githubusercontent.com/SSWConsulting/SSW.People.Profiles/main/{Person-Name}/Images/{Person-Name}-Profile.jpg
```

**Resolving `{Person-Name}` (the folder slug):**

The slug is pre-resolved against the SSW.People.Profiles folder list and stored in `attendees.json`. **Always prefer the pre-resolved value over guessing from the display name** — Teams display names may use nicknames (e.g. "Tom Iwainski") that don't match the actual folder ("Thomas-Iwainski").

For each participant card, look up the slug in this order:
1. **Invitees**: find the invitee in `attendees.json -> invitees[]` whose `derivedName` matches the participant. Use their `sswProfileSlug`.
2. **VTT-tagged speakers**: look the participant's name up in `attendees.json -> vttInfo.taggedSpeakerSlugs` (a map of speaker name → slug). Use that slug.
3. **No entry** (e.g. an external guest with no invite + no `<v>` tag): fall back to constructing `{First-Last}` from their name with normal capitalization.

**Slug field semantics:**
- `sswProfileSlug: "Thomas-Iwainski"` → use that exact slug in the URL
- `sswProfileSlug: null` → the resolver couldn't disambiguate. **Render the initials placeholder directly** instead of guessing — do NOT construct a URL from the display name in this case (it would either 404 or, worse, point to the wrong person).
- Field absent → use the construction fallback above

**Manual conversion rules (only when constructing from a name as a fallback):**
- Convert spaces to hyphens: "Bob Northwind" → "Bob-Northwind"
- Preserve capitalization: "Adam Cogan" → "Adam-Cogan"

#### Participant Card HTML Structure

Each participant is one `ds-card` inside the `{{PARTICIPANT_CARDS}}` grid. Avatar size is 48px (`ssw/avatar.tsx` "large"). Key finding + Strengths/Feedback bands use inline `style` colors (`var(--text-success)` / `var(--text-warning)`), not Tailwind color utilities:

```html
<div class="ds-card">
  <div class="px-4 pt-4 flex items-start gap-3">
    <!-- Profile Photo: ds-avatar, 48px. Fallback to initials is handled by
         the template's .js-profile-image error-listener script. -->
    <div class="ds-avatar" style="width: 48px; height: 48px;">
      <img src="https://raw.githubusercontent.com/SSWConsulting/SSW.People.Profiles/main/Bob-Northwind/Images/Bob-Northwind-Profile.jpg"
           alt="Bob Northwind"
           class="js-profile-image"
           data-initials="BN">
    </div>

    <!-- Info Section -->
    <div class="flex-1">
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="font-medium" style="color: var(--text-strong);">Bob Northwind</p>
          <p class="text-sm" style="color: var(--text-weak);">Senior Developer</p>
        </div>
        <span class="ds-badge ds-badge-secondary">18% speaking</span>
      </div>

      <!-- Value Score -->
      <div class="mt-3 flex items-center gap-2">
        <div class="value-bar-track flex-1">
          <div class="value-bar-fill" style="width: 80%; background: var(--text-success);"></div>
        </div>
        <span class="text-xs font-semibold" style="color: var(--text-strong);">8/10</span>
      </div>

      <!-- Key Finding -->
      <p class="text-sm mt-3" style="color: var(--text-weak);">
        <span class="font-medium" style="color: var(--text-strong);">Key finding:</span>
        Highest value-per-minute but systematically underutilized
      </p>
    </div>
  </div>

  <div class="px-4 py-4 mt-2 space-y-3">
    <!-- Strengths (prominent band - the written feedback is the focus of the card) -->
    <div class="rounded p-3" style="background: var(--fill-success-weak); border-left: 3px solid var(--text-success);">
      <p class="text-xs font-semibold uppercase tracking-wide mb-1" style="color: var(--text-success);">Strengths</p>
      <ul class="text-sm space-y-1" style="color: var(--text-strong);">
        <li><span class="font-semibold">Efficiency</span> - every word counted, no filler</li>
        <li><span class="font-semibold">Technical depth</span> - highly valuable when consulted</li>
      </ul>
    </div>

    <!-- Feedback (prominent band) -->
    <div class="rounded p-3" style="background: var(--fill-warning-weak); border-left: 3px solid var(--text-warning);">
      <p class="text-xs font-semibold uppercase tracking-wide mb-1" style="color: var(--text-warning);">Feedback</p>
      <ul class="text-sm space-y-1" style="color: var(--text-strong);">
        <li><span class="font-semibold">Push back</span> - when interrupted, hold your ground; your points matter</li>
        <li><span class="font-semibold">Initiative</span> - you don't need permission to contribute</li>
      </ul>
    </div>
  </div>
</div>
```

#### Fallback for Non-SSW Participants

For participants who don't have SSW profiles, use their initials as a fallback (same 48px `ds-avatar` box, no `<img>`):

```html
<div class="ds-avatar" style="width: 48px; height: 48px;">
  <div class="ds-avatar-fallback">JD</div>
</div>
```

The template includes a script that automatically falls back to initials (from `data-initials`) when images fail to load. **Security note:** The `data-initials` attribute MUST only contain values derived from trusted participant data (canonical names from the transcript), never from user-controllable input.

**Initials Calculation:**
- "John Doe" → "JD"
- "Alice Smith" → "AS"
- Single name "Charlie" → "C"

## Deployment

**Do NOT deploy the dashboard.** Deployment, and building `dashboard/index.html` itself from your fragments, are both handled automatically by `processor/index.js`. Your only job is to save the fragment files to:

```
projects/{project}/{meeting-id}/dashboard-parts/{PLACEHOLDER_NAME}.html
```

## DO NOT

- Create .md files
- Provide just a text summary
- Skip any analysis agent
- **Skip the consolidation step**
- Use inconsistent names across tabs
- Generate a simple single-tab page
- Deploy the dashboard (processor.js handles deployment)
- Write `dashboard/index.html` yourself, or author any static chrome (Design System tokens/CSS, tab-switching script, profile-image fallback script) - `processor/index.js` builds it deterministically from `templates/dashboard.html` plus your fragments
- Rush through the analysis - THIS IS IMPORTANT