import { createHash } from 'node:crypto';
import { isEmployee, normalizedEmail } from './config.js';

const allowedRoles = new Set(['User', 'Admin']);
const text = value => typeof value === 'string' && value.length <= 512 ? value : undefined;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class UserAccessError extends Error {}

export class UserStore {
  constructor(container, issuer, now = () => new Date()) { this.container = container; this.issuer = issuer; this.now = now; }
  id(subject) {
    if (typeof subject !== 'string' || !subject || subject.length > 256) throw new Error('Invalid user subject');
    return hash([this.issuer, subject]);
  }
  emailId(email) { return `email-${hash([this.issuer, normalizedEmail(email)])}`; }
  identityId(subject) { return `identity-${this.id(subject)}`; }
  emailBlockId(email) {
    const normalized = normalizedEmail(email);
    if (!normalized) throw new Error('Invalid email');
    return `email-block-${hash([this.issuer, normalized])}`;
  }
  // Stored records must match the id, type and issuer they were looked up by.
  owns(record, id, type) { return record.id === id && record.type === type && record.issuer === this.issuer; }
  async document(id) {
    try {
      const { resource } = await this.container.item(id, id).read();
      return resource || null;
    } catch (error) { if (error.code === 404) return null; throw error; }
  }
  async readUser(id) {
    const user = await this.document(id);
    if (!user) return null;
    if (!this.owns(user, id, 'user')
      || typeof user.sub !== 'string' || !user.sub || typeof user._etag !== 'string'
      || typeof user.isActive !== 'boolean' || typeof user.emailVerified !== 'boolean'
      || normalizedEmail(user.email) !== user.email || !user.email
      || !Array.isArray(user.roles) || !user.roles.every(role => allowedRoles.has(role))) {
      throw new Error('Invalid stored user');
    }
    return { user, etag: user._etag };
  }
  async read(subject) {
    const identity = await this.document(this.identityId(subject));
    if (identity) {
      if (!this.owns(identity, this.identityId(subject), 'identity')
        || identity.sub !== subject || typeof identity.userId !== 'string' || !identity.userId) throw new Error('Invalid stored identity');
      const stored = await this.readUser(identity.userId);
      if (!stored) throw new Error('Identity user missing');
      return stored;
    }
    // Support legacy sessions and users by backfilling identity mappings on first login.
    const stored = await this.readUser(this.id(subject));
    if (stored && stored.user.sub !== subject) throw new Error('Invalid stored user');
    return stored;
  }
  async assertEmailAllowed(email) {
    const id = this.emailBlockId(email);
    const block = await this.document(id);
    if (!block) return;
    if (!this.owns(block, id, 'emailBlock')
      || block.email !== normalizedEmail(email) || typeof block.isBlocked !== 'boolean') throw new Error('Invalid email block');
    if (block.isBlocked) throw new UserAccessError('account_disabled');
  }
  async assertAllowed(user) {
    if (!user.isActive || !isEmployee({ sub: user.sub, email: user.email, email_verified: user.emailVerified })) {
      throw new UserAccessError('account_disabled');
    }
    await this.assertEmailAllowed(user.email);
    return user;
  }
  async authorize(subject) {
    const stored = await this.read(subject);
    if (!stored) throw new UserAccessError('account_not_registered');
    return this.assertAllowed(stored.user);
  }
  async createOnce(value) {
    let saved = await this.document(value.id);
    if (!saved) {
      try { await this.container.items.create(value); }
      catch (error) { if (error.code !== 409) throw error; }
      saved = await this.document(value.id);
    }
    if (!saved || Object.keys(value).some(key => saved[key] !== value[key])) {
      throw new UserAccessError('account_link_conflict');
    }
    return saved;
  }
  async emailOwner(email, preferred) {
    const id = this.emailId(email);
    let index = await this.document(id);
    if (!index) {
      // Legacy records may lack an email index; duplicates require manual review to preserve disabled status and roles.
      const { resources } = await this.container.items.query({
        query: 'SELECT * FROM c WHERE c.type = @type AND c.issuer = @issuer AND LOWER(c.email) = @email',
        parameters: [{ name: '@type', value: 'user' }, { name: '@issuer', value: this.issuer }, { name: '@email', value: email }],
      }).fetchAll();
      if (resources.length > 1) throw new UserAccessError('account_link_conflict');
      const candidate = resources[0]?.id || preferred || `user-${hash([this.issuer, email])}`;
      try { await this.container.items.create({ id, type: 'emailIdentity', issuer: this.issuer, email, userId: candidate }); }
      catch (error) { if (error.code !== 409) throw error; }
      index = await this.document(id);
    }
    if (!index || !this.owns(index, id, 'emailIdentity')
      || index.email !== email || typeof index.userId !== 'string' || !index.userId) throw new Error('Invalid email identity');
    if (preferred && index.userId !== preferred) throw new UserAccessError('account_link_conflict');
    return index.userId;
  }
  async register(claims, { login = false } = {}) {
    if (!isEmployee(claims)) throw new UserAccessError('ssw_staff_only');
    const email = normalizedEmail(claims.email);
    const loginAt = login ? this.now().toISOString() : undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.read(claims.sub);
      if (existing) await this.assertAllowed(existing.user);
      await this.assertEmailAllowed(email);
      const id = await this.emailOwner(email, existing?.user.id);
      const stored = await this.readUser(id);
      const previous = stored?.user;
      if (previous) {
        await this.assertAllowed(previous);
        // Allow linked identities to update email addresses; retain old email indexes to prevent reassignment to another user.
        if (!existing && previous.email !== email) throw new UserAccessError('account_link_conflict');
      }
      const user = {
        id, type: 'user', issuer: this.issuer, sub: previous?.sub || claims.sub,
        name: text(claims.full_name) || text(claims.name) || previous?.name,
        email, emailVerified: true,
        // All linked identities share the internal user roles and disabled status; ignore roles from tokens.
        roles: previous?.roles || ['User'], isActive: previous?.isActive ?? true,
        createdAt: previous?.createdAt || this.now().toISOString(),
        ...(previous?.lastLoginAt ? { lastLoginAt: previous.lastLoginAt } : {}),
      };
      if (loginAt && (!user.lastLoginAt || loginAt > user.lastLoginAt)) user.lastLoginAt = loginAt;
      const unchanged = previous && ['name', 'email', 'emailVerified', 'lastLoginAt'].every(key => user[key] === previous[key]);
      const { _etag, _rid, _self, _attachments, _ts, ...fields } = previous || {};
      const next = { ...fields, ...user, updatedAt: this.now().toISOString() };
      try {
        if (!unchanged) {
          if (stored) {
            await this.container.item(id, id).replace(next, { accessCondition: { type: 'IfMatch', condition: stored.etag } });
          } else {
            await this.container.items.create(next);
          }
        }
        // Link each identity only once; retries after failures must preserve existing links.
        await this.createOnce({ id: this.identityId(claims.sub), type: 'identity', issuer: this.issuer, sub: claims.sub, userId: id });
        await this.assertEmailAllowed(email);
        return this.authorize(claims.sub);
      } catch (error) { if (![409, 412].includes(error.code)) throw error; }
    }
    throw new Error('User changed concurrently; retry the request');
  }
}

export function publicUser(user, subject = user.sub) {
  // Keep the login subject in the session and validate it against the issuing identity when refreshing tokens.
  return { id: user.id, sub: subject, name: user.name, email: user.email, roles: user.roles };
}
