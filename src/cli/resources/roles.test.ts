/**
 * Regression coverage for the roles CLI resource's grant/revoke flag
 * aliasing (--user vs --user-id, --group vs --agent-group-id). The
 * auto-generated resource "Fields:" help lists --user-id/--agent-group-id
 * (derived from the generic column names), but the verb description and the
 * original handler only accepted --user/--group — a caller following either
 * help section would fail depending on which one they read. See the comment
 * in roles.ts.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getResources } from '../crud.js';
import './roles.js';

function grant(): (args: Record<string, unknown>) => Promise<unknown> {
  const roles = getResources().find((r) => r.plural === 'roles');
  const handler = roles?.customOperations?.grant.handler;
  if (!handler) throw new Error('roles.grant not registered');
  return handler as (args: Record<string, unknown>) => Promise<unknown>;
}

function revoke(): (args: Record<string, unknown>) => Promise<unknown> {
  const roles = getResources().find((r) => r.plural === 'roles');
  const handler = roles?.customOperations?.revoke.handler;
  if (!handler) throw new Error('roles.revoke not registered');
  return handler as (args: Record<string, unknown>) => Promise<unknown>;
}

let db: Database.Database;

function grantedRoles(userId: string): unknown[] {
  return db.prepare('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?').all(userId);
}

function seedUser(userId: string): void {
  db.prepare('INSERT INTO users (id, kind, created_at) VALUES (?, ?, ?)').run(
    userId,
    userId.split(':')[0],
    new Date().toISOString(),
  );
}

function seedAgentGroup(id: string): void {
  db.prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    id,
    id,
    new Date().toISOString(),
  );
}

beforeEach(() => {
  db = initTestDb();
  runMigrations(db);
  for (const id of ['telegram:alice', 'telegram:bob', 'telegram:carol', 'telegram:dave', 'telegram:erin']) {
    seedUser(id);
  }
  seedAgentGroup('ag-1');
  seedAgentGroup('ag-2');
});

afterEach(() => {
  closeDb();
});

describe('roles.grant — flag aliasing', () => {
  it('accepts --user (documented in the verb description)', async () => {
    await grant()({ user: 'telegram:alice', role: 'owner' });
    expect(grantedRoles('telegram:alice')).toEqual([{ role: 'owner', agent_group_id: null }]);
  });

  it('accepts --user-id (what the auto-generated Fields section advertises)', async () => {
    await grant()({ user_id: 'telegram:bob', role: 'owner' });
    expect(grantedRoles('telegram:bob')).toEqual([{ role: 'owner', agent_group_id: null }]);
  });

  it('accepts --group for scoped admin', async () => {
    await grant()({ user: 'telegram:carol', role: 'admin', group: 'ag-1' });
    expect(grantedRoles('telegram:carol')).toEqual([{ role: 'admin', agent_group_id: 'ag-1' }]);
  });

  it('accepts --agent-group-id (normalized to agent_group_id) as an alias for --group', async () => {
    await grant()({ user: 'telegram:dave', role: 'admin', agent_group_id: 'ag-2' });
    expect(grantedRoles('telegram:dave')).toEqual([{ role: 'admin', agent_group_id: 'ag-2' }]);
  });

  it('still rejects when neither --user nor --user-id is given', async () => {
    await expect(grant()({ role: 'owner' })).rejects.toThrow('--user is required');
  });
});

describe('roles.revoke — flag aliasing', () => {
  it('accepts --user-id to revoke a role granted via --user', async () => {
    await grant()({ user: 'telegram:erin', role: 'owner' });
    await revoke()({ user_id: 'telegram:erin', role: 'owner' });
    expect(grantedRoles('telegram:erin')).toEqual([]);
  });
});
