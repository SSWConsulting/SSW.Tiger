import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserStore, UserAccessError } from '../src/users.js';
import { memoryUsers } from './helpers.js';

const claims = { sub: 'employee', name: 'Original', email: 'Staff@ssw.com.au', email_verified: true };

test('registration is idempotent, isolates issuers and links verified email without granting token roles', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const [user, parallel] = await Promise.all([users.register({ ...claims, roles: ['Admin'] }), users.register(claims)]);
  assert.deepEqual(parallel, user);
  assert.deepEqual(user.roles, ['User']);
  assert.equal(user.email, 'staff@ssw.com.au');
  assert.equal(user.isActive, true);
  assert.deepEqual(await users.register(claims), user);
  assert.equal(container.writes, 3);
  await new UserStore(container, 'https://other.test').register(claims);
  const linked = await users.register({ ...claims, sub: 'another', email: 'STAFF@ssw.com.au' });
  assert.equal(linked.id, user.id);
  assert.equal((await users.read('another')).user.id, user.id);
  assert.equal([...container.documents.values()].filter(value => value.type === 'user').length, 2);
});

test('only Portal logins update lastLoginAt; profile refresh preserves operator fields and roles', async () => {
  const container = memoryUsers(); let now = new Date('2026-10-27T00:00:00Z');
  const users = new UserStore(container, 'https://identity.test', () => now);
  const original = await users.register(claims);
  assert.equal(original.lastLoginAt, undefined);
  container.documents.set(original.id, { ...original, roles: ['Admin'], note: 'Operator note', _etag: 'operator' });
  const login = await users.register(claims, { login: true });
  assert.equal(login.lastLoginAt, now.toISOString());
  now = new Date('2026-10-27T01:00:00Z');
  const refresh = await users.register({ ...claims, name: 'New', roles: ['User'] });
  assert.equal(refresh.lastLoginAt, login.lastLoginAt);
  assert.equal(refresh.createdAt, original.createdAt);
  assert.deepEqual(refresh.roles, ['Admin']);
  assert.equal(refresh.note, 'Operator note');
  assert.equal((await users.register(claims, { login: true })).lastLoginAt, now.toISOString());
});

test('ETag retries preserve concurrent operator changes and cannot resurrect a disabled account', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const original = await users.register(claims);
  container.beforeWrite = id => container.documents.set(id, { ...original, roles: ['Admin'], _etag: 'operator' });
  const refreshed = await users.register({ ...claims, name: 'New' });
  assert.deepEqual(refreshed.roles, ['Admin']);
  container.beforeWrite = id => container.documents.set(id, { ...refreshed, isActive: false, _etag: 'disabled' });
  await assert.rejects(users.register(claims, { login: true }), UserAccessError);
  assert.equal((await users.read(claims.sub)).user.isActive, false);
  await assert.rejects(users.register({ ...claims, email: 'new@ssw.com.au' }), UserAccessError);
});

test('email blocks revoke all existing subjects and deny new subjects regardless of email case', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  await users.register(claims);
  await users.register({ ...claims, sub: 'other-login' });
  const id = users.emailBlockId(claims.email);
  container.documents.set(id, { id, type: 'emailBlock', issuer: users.issuer, email: 'staff@ssw.com.au', isBlocked: true });
  for (const sub of ['employee', 'other-login']) await assert.rejects(users.authorize(sub), UserAccessError);
  await assert.rejects(users.register({ ...claims, sub: 'new-login', email: 'STAFF@SSW.COM.AU' }), UserAccessError);
  assert.equal(await users.read('new-login'), null);
});

test('unverified claims, corrupt records, missing users and database outages fail closed', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  for (const email_verified of [false, undefined, 'true', 1]) await assert.rejects(users.register({ ...claims, email_verified }), UserAccessError);
  await assert.rejects(users.authorize('missing'), UserAccessError);
  const user = await users.register(claims);
  container.documents.set(user.id, { ...user, roles: ['Unknown'] });
  await assert.rejects(users.read('employee'), /Invalid stored user/);
  const broken = new UserStore({ item() { return { async read() { throw new Error('unavailable'); } }; } }, users.issuer);
  await assert.rejects(broken.register(claims), /unavailable/);
});

test('concurrent different subjects share one internal user and independent identity records', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const subjects = ['microsoft', 'password', 'third-login'];
  const results = await Promise.all(subjects.map(sub => users.register({ ...claims, sub })));
  assert.equal(new Set(results.map(user => user.id)).size, 1);
  assert.equal([...container.documents.values()].filter(value => value.type === 'user').length, 1);
  for (const sub of subjects) assert.equal((await users.authorize(sub)).id, results[0].id);
});

test('linked identities inherit stored roles and revocation without changing operator audit fields', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const user = await users.register(claims);
  container.documents.set(user.id, { ...user, roles: ['Admin'], note: 'Keep this', _etag: 'operator' });
  const linked = await users.register({ ...claims, sub: 'password', name: 'Updated' });
  assert.equal(linked.id, user.id);
  assert.deepEqual(linked.roles, ['Admin']);
  assert.equal(linked.note, 'Keep this');
  container.documents.set(user.id, { ...linked, isActive: false, disabledReason: 'Offboarded', _etag: 'disabled' });
  for (const sub of [claims.sub, 'password']) await assert.rejects(users.authorize(sub), UserAccessError);
  await assert.rejects(users.register({ ...claims, sub: 'new-login' }), UserAccessError);
  assert.equal(await users.read('new-login'), null);
  assert.equal(container.documents.get(user.id).disabledReason, 'Offboarded');
});

function legacyUser(users, sub, overrides = {}) {
  return { id: users.id(sub), type: 'user', issuer: users.issuer, sub, email: 'staff@ssw.com.au',
    emailVerified: true, roles: ['Admin'], isActive: true, createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', note: 'Legacy audit', _etag: 'legacy', ...overrides };
}

test('new login links to a legacy user without changing its ID, roles or creation date', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const legacy = legacyUser(users, 'original'); container.documents.set(legacy.id, legacy);
  assert.equal((await users.authorize('original')).id, legacy.id);
  const linked = await users.register({ ...claims, sub: 'new-login' });
  assert.equal(linked.id, legacy.id);
  assert.deepEqual(linked.roles, ['Admin']);
  assert.equal(linked.createdAt, legacy.createdAt);
  assert.equal(linked.note, 'Legacy audit');
  await users.register({ ...claims, sub: 'original' });
  assert.equal((await users.authorize('original')).id, linked.id);
});

test('disabled and ambiguous legacy accounts never get replaced by a new active user', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const disabled = legacyUser(users, 'old', { isActive: false }); container.documents.set(disabled.id, disabled);
  await assert.rejects(users.register({ ...claims, sub: 'new' }), UserAccessError);
  assert.equal(await users.read('new'), null);
  container.documents.set(disabled.id, { ...disabled, isActive: true });
  const duplicate = legacyUser(users, 'duplicate'); container.documents.set(duplicate.id, duplicate);
  // Clear the incomplete email reservation to simulate two existing legacy records with the same email before rollout.
  container.documents.delete(users.emailId(claims.email));
  await assert.rejects(users.register({ ...claims, sub: 'new' }), /account_link_conflict/);
  assert.equal(await users.read('new'), null);
});

test('an identity cannot move to another internal user by changing its verified email', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const first = await users.register(claims);
  await users.register({ ...claims, sub: 'other-person', email: 'other@ssw.com.au' });
  await assert.rejects(users.register({ ...claims, email: 'other@ssw.com.au' }), /account_link_conflict/);
  assert.equal((await users.authorize(claims.sub)).id, first.id);
  const updated = await users.register({ ...claims, email: 'renamed@ssw.com.au' });
  assert.equal(updated.id, first.id);
  assert.deepEqual(updated.roles, first.roles);
  await assert.rejects(users.register({ ...claims, sub: 'old-mailbox-new-person' }), /account_link_conflict/);
});

test('partial creation retries converge and corrupt identity mappings deny access', async () => {
  const container = memoryUsers(); const users = new UserStore(container, 'https://identity.test');
  const create = container.items.create;
  let fail = true;
  container.items.create = async value => {
    if (value.type === 'identity' && fail) { fail = false; throw new Error('outage'); }
    return create(value);
  };
  await assert.rejects(users.register(claims), /outage/);
  const recovered = await users.register({ ...claims, sub: 'alternative' });
  assert.equal((await users.register(claims)).id, recovered.id);
  container.documents.set(users.identityId(claims.sub), { id: users.identityId(claims.sub), type: 'identity', issuer: users.issuer, sub: claims.sub, userId: 'missing' });
  await assert.rejects(users.authorize(claims.sub), /Identity user missing/);
});
