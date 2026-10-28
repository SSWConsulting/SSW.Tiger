// Build the project list from meeting reports while supporting name metadata from legacy project pages.
import { safeSegment } from './config.js';

// en-AU abbreviates September as "Sept", which breaks the 3-letter date tile.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function decodeName(value, fallback) {
  try { return value ? decodeURIComponent(value) : fallback; } catch { return fallback; }
}

// Hide random identifiers after timestamps; retain readable legacy meeting names as titles.
function suffixLabel(suffix = '') {
  const time = /^(\d{2})(\d{2})(\d{2})?(?:-|$)/.exec(suffix);
  if (time && Number(time[1]) < 24 && Number(time[2]) < 60 && (!time[3] || Number(time[3]) < 60)) {
    return `Meeting · ${time[1]}:${time[2]}`;
  }
  if (!suffix || /(?:^|-)(?:[a-f0-9]{8,}|\d+)(?:-|$)/i.test(suffix)) return 'Meeting';
  return suffix.split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

export function meetingSummary(id) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:-(.+))?$/.exec(id);
  if (!match) return { id, sortKey: '', title: suffixLabel(id), date: '', day: '', month: '', weekday: '' };
  const [, year, month, day, suffix] = match;
  const when = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const format = options => when.toLocaleDateString('en-AU', { timeZone: 'UTC', ...options });
  const label = suffixLabel(suffix);
  return {
    id,
    sortKey: id,
    title: label,
    date: `${day}/${month}/${year}`,
    day: String(Number(day)),
    month: MONTHS[Number(month) - 1],
    weekday: format({ weekday: 'long' }),
    monthGroup: format({ month: 'long', year: 'numeric' }),
  };
}

// Whole-number meeting stats ready for display; missing or invalid Cosmos values are left out.
export function meetingStats(metadata = {}) {
  const count = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  return { minutes: count(metadata.totalDurationMinutes), people: count(metadata.participantCount), actionItems: count(metadata.actionItemsCount) };
}

const newestFirst = (a, b) => b.sortKey.localeCompare(a.sortKey) || b.id.localeCompare(a.id);

// Projects without any published meeting are left out.
export function projectsFromBlobs(blobs) {
  const projects = new Map();
  const entry = project => projects.get(project) ?? projects.set(project, { project, displayName: project, meetings: [] }).get(project);
  for (const blob of blobs) {
    const parts = blob.name.split('/');
    if (parts.at(-1) !== 'index.html' || parts.length < 2 || parts.length > 3 || !parts.slice(0, -1).every(safeSegment)) continue;
    const project = entry(parts[0]);
    if (parts.length === 2) project.displayName = decodeName(blob.metadata?.displayname, parts[0]);
    else project.meetings.push({ ...meetingSummary(parts[1]), displayName: decodeName(blob.metadata?.displayname, '') });
  }
  return [...projects.values()]
    .filter(project => project.meetings.length)
    .map(project => {
      const meetings = project.meetings.sort(newestFirst);
      return { ...project, displayName: meetings.find(meeting => meeting.displayName)?.displayName || project.displayName, meetings };
    })
    .sort((a, b) => newestFirst(a.meetings[0], b.meetings[0]) || a.displayName.localeCompare(b.displayName));
}
