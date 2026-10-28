import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingSummary, projectsFromBlobs } from '../src/projects.js';

test('meeting summaries read the date and label from the meeting ID', () => {
  assert.deepEqual(
    (({ title, date, day, month, weekday }) => ({ title, date, day, month, weekday }))(meetingSummary('2026-01-22-sprint-review')),
    { title: 'Sprint Review', date: '22/01/2026', day: '22', month: 'Jan', weekday: 'Thursday' },
  );
  assert.equal(meetingSummary('2026-01-22-094557').title, 'Meeting · 09:45');
  assert.equal(meetingSummary('2026-01-22').title, 'Meeting');
  assert.equal(meetingSummary('kickoff').title, 'Kickoff');
});

test('projects group meetings newest first and skip projects without meetings', () => {
  const projects = projectsFromBlobs([
    { name: 'alpha/index.html', metadata: { displayname: 'Alpha%20Team' } },
    { name: 'alpha/2026-01-08/index.html' },
    { name: 'alpha/2026-01-22/index.html' },
    { name: 'beta/2026-02-01/index.html' },
    { name: 'beta/index.html', metadata: { displayname: '%E0%A4%A' } },
    { name: 'empty/index.html' },
    { name: 'alpha/2026-01-22/analysis/index.html' },
    { name: '../2026-01-01/index.html' },
  ]);
  assert.deepEqual(projects.map(p => [p.displayName, p.meetings.map(m => m.id)]), [
    ['beta', ['2026-02-01']],
    ['Alpha Team', ['2026-01-22', '2026-01-08']],
  ]);
});

test('projects need no static index and use the latest report display name', () => {
  const blobs = [
    { name: 'yakshaver/2026-10-28/index.html', metadata: { displayname: 'YakShaver%20Team' } },
    { name: 'yakshaver/2026-10-21/index.html', metadata: { displayname: 'Old%20Name' } },
  ];
  for (const listing of [blobs, [...blobs].reverse()]) {
    const [project] = projectsFromBlobs(listing);
    assert.equal(project.displayName, 'YakShaver Team');
    assert.equal(project.meetings.length, 2);
  }
});

test('published meetings keep Cosmos people and metrics without adding unpublished records', async () => {
  const { listProjects } = await import('../src/storage.js');
  const { projectPage, projectsPage } = await import('../src/views.js');
  const reports = { async *listBlobsFlat() {
    yield { name: 'yak/2026-10-26-162717/index.html' };
    yield { name: 'yak/2026-10-19/index.html' };
    yield { name: 'other/2026-10-26-162717/index.html' };
  } };
  const meetings = { items: { query(spec) {
    assert.doesNotMatch(spec.query, /consolidated/);
    return { async fetchAll() { return { resources: [
      { projectName: 'yak', meetingId: '2026-10-26-162717', metadata: { participantCount: 6, totalDurationMinutes: 42.2, actionItemsCount: 0 } },
      { projectName: 'other', meetingId: '2026-10-26-162717', metadata: { participantCount: 3 } },
      { projectName: 'yak', meetingId: 'unpublished', metadata: { participantCount: 99 } },
    ] }; } };
  } } };
  const projects = await listProjects(reports, undefined, meetings);
  const yak = projects.find(item => item.project === 'yak');
  assert.equal(yak.meetings.length, 2);
  assert.equal(projects.find(item => item.project === 'other').meetings[0].stats.people, 3);
  const html = projectPage(yak, { name: '<Staff>' });
  assert.match(html, /6 people/);
  assert.match(html, /42 min/);
  assert.match(html, /0 action items/);
  assert.match(html, /19\/10\/2026/);
  assert.doesNotMatch(html, /99 people/);
  assert.match(html, /&lt;Staff&gt;/);
  assert.match(projectsPage(projects, { name: 'Staff' }), /6 people/);
  meetings.items.query = () => { throw new Error('Cosmos unavailable'); };
  await assert.rejects(listProjects(reports, 'yak', meetings), /Cosmos unavailable/);
});


test('machine suffixes never become visible meeting titles', async () => {
  for (const id of ['2026-08-21-152902-e1920a4b', '2026-08-21-152902', '2026-08-21-1529-e1920a4b']) {
    assert.equal(meetingSummary(id).title, 'Meeting · 15:29');
  }
  for (const id of ['2026-08-21-e1920a4b', '2026-08-21-256199-e1920a4b', '2026-08-21', 'e1920a4b']) {
    assert.equal(meetingSummary(id).title, 'Meeting');
  }
  const { projectPage, projectsPage } = await import('../src/views.js');
  const project = { project: 'yak', displayName: 'YakShaver', meetings: [
    { ...meetingSummary('2026-08-21-152902-e1920a4b'), stats: { people: 6 } },
    { ...meetingSummary('2026-08-21-sprint-review'), title: 'A long meeting title <with details> & follow-up' },
  ] };
  for (const html of [projectPage(project, { name: 'Staff' }), projectsPage([project], { name: 'Staff' })]) {
    assert.match(html, /<strong title="Meeting · 15:29(?: · 6 people)?">Meeting · 15:29<\/strong>/);
    assert.match(html, /Friday · 21\/08\/2026/);
    assert.match(html, /6 people/);
    assert.match(html, /href="\/yak\/2026-08-21-152902-e1920a4b\/"/);
    assert.doesNotMatch(html.replace(/href="[^"]*"/g, ''), /e1920a4b|152902/);
    assert.match(html, /A long meeting title &lt;with details&gt; &amp; follow-up/);
  }
});


test('home keeps calendar tiles and people in hover text, while project pages keep people chips', async () => {
  const { projectPage, projectsPage } = await import('../src/views.js');
  const project = { project: 'yak', displayName: 'YakShaver', meetings: [
    { ...meetingSummary('2026-08-21-152902-e1920a4b'), stats: { people: 6 } },
    meetingSummary('kickoff'),
  ] };
  const home = projectsPage([project], { name: 'Staff' });
  assert.match(home, /title="Meeting · 15:29 · 6 people"/);
  assert.doesNotMatch(home, /class="meeting-chip">6 people/);
  assert.match(home, /class="date-month">Aug/);
  assert.match(home, /class="date-day">21/);
  assert.match(home, /date-tile-blank/);
  const detail = projectPage(project, { name: 'Staff' });
  assert.match(detail, /class="meeting-chip">6 people/);
  assert.doesNotMatch(detail, /class="date-tile"/);
});
