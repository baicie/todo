import { beforeEach, describe, expect, it } from 'vitest';
import type { SharedSession } from './shared-sync';
import { SharedSyncEngine } from './shared-sync';
import type { SharedListRecord, SharedOpRecord, SharedStore } from './shared-store';
import { DexieTaskRepository } from '../adapters/web-repository';

/**
 * Legacy shared cache read isolation (V1.1-RC1 final review, P2).
 *
 * Releases before the account binding existed wrote shared lists and an outbox
 * into `sharedMeta`/`sharedLists`/`sharedOutbox` WITHOUT `accountBinding`. If
 * that space is readable while it is unbound, any later session sees the data
 * of whoever wrote it - a confidentiality leak across accounts on one device.
 *
 * The compatibility path must therefore be narrower than "unbound means read":
 * an account may read the legacy space only when the local data space already
 * proves it belongs to that account, and only that account may adopt it.
 */

const NOW = '2026-11-01T00:00:00.000Z';
const OWNER_ID = '019a0000-0000-7000-8000-000000000001';
const ACCOUNT_A: SharedSession = {
  token: 'session-a',
  account: { email: 'a@example.com', apiUrl: 'https://api.example' },
};
const ACCOUNT_B: SharedSession = {
  token: 'session-b',
  account: { email: 'b@example.com', apiUrl: 'https://api.example' },
};

let databases = 0;
function newRepository(): DexieTaskRepository {
  databases += 1;
  return new DexieTaskRepository(`legacy-shared-${databases}`);
}

function legacyStore(repository: DexieTaskRepository): SharedStore {
  return repository.sharedStore();
}

/** Write the pre-binding shape: a list, a task and a queued op, no binding. */
async function seedLegacy(store: SharedStore, listId: string): Promise<void> {
  const summary = {
    id: listId,
    owner_id: OWNER_ID,
    name: 'A 的旧清单',
    color: null,
    icon: null,
    rank: 'a0',
    revision: 1,
    role: 'owner' as const,
    created_at: NOW,
    updated_at: NOW,
  };
  const record: SharedListRecord = {
    id: listId,
    summary,
    snapshot: { members: [], invitations: [], tasks: [], steps: [] },
    revision: 1,
    access: 'active',
    syncedAt: NOW,
    error: null,
  };
  const op: SharedOpRecord = {
    opId: '019b9000-0000-7000-8000-00000000a001',
    listId,
    seq: 1,
    kind: 'create',
    taskId: '019b2000-0000-7000-8000-000000000001',
    patch: { title: 'A 未发送的编辑' },
    base: {},
    status: 'pending',
    errorCode: null,
    createdAt: NOW,
  };
  await store.transact(async (tx) => {
    await tx.putList(record);
    await tx.putTask({
      id: op.taskId,
      list_id: listId,
      title: 'A 未发送的编辑',
      note: '',
      status: 'open',
      important: false,
      due_on: null,
      rank: 'a0',
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
      position: 0,
      pending: true,
    });
    await tx.putOp(op);
    await tx.setMeta('invitations', JSON.stringify([{ id: 'inv-a', list_id: listId }]));
  });
}

function engineFor(
  repository: DexieTaskRepository,
  store: SharedStore,
  session: { current: SharedSession | null },
): SharedSyncEngine {
  return new SharedSyncEngine({
    // No request is expected in these tests; any network attempt is a failure
    // of the isolation itself.
    request: () => {
      throw new Error('the legacy-cache tests must not reach the network');
    },
    store,
    session: () => session.current,
    ownerHint: async () => (await repository.syncGetDiagnostics()).boundAccount,
  });
}

/** Bind the personal data space the way a completed login does. */
async function bindPersonal(
  repository: DexieTaskRepository,
  session: SharedSession,
): Promise<void> {
  await repository.syncSetSession(session.token);
  await repository.syncSetEnabled(true);
  await repository.syncInitializeCloud(
    { cursor: '0', lists: [], tasks: [], steps: [], dayPlans: [] },
    'cloud',
    session.account.email,
    session.token,
  );
}

const LIST_ID = '019b1000-0000-7000-8000-000000000001';

describe('legacy shared cache read isolation', () => {
  beforeEach(() => {
    databases += 1;
  });

  it('does not show an unbound legacy space to a different account', async () => {
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await seedLegacy(store, LIST_ID);
    expect(await store.boundAccount!()).toBeNull();

    const session: { current: SharedSession | null } = { current: ACCOUNT_B };
    const b = engineFor(repository, store, session);

    const view = await b.read();
    expect(view.lists).toEqual([]);
    expect(view.invitations).toEqual([]);
  });

  it('does not show an unbound legacy space with no session at all', async () => {
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await seedLegacy(store, LIST_ID);

    const session: { current: SharedSession | null } = { current: null };
    const engine = engineFor(repository, store, session);

    expect(await engine.read()).toEqual({ lists: [], invitations: [] });
  });

  it('shows an unbound legacy space to its own account once the personal space is bound', async () => {
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await seedLegacy(store, LIST_ID);
    await bindPersonal(repository, ACCOUNT_A);

    const session: { current: SharedSession | null } = { current: ACCOUNT_A };
    const a = engineFor(repository, store, session);

    // Reading is enough here: the engine must not need a network round trip to
    // decide that this legacy space is A's.
    const view = await a.read();
    expect(view.lists.map((item) => item.record.summary.name)).toEqual(['A 的旧清单']);
    expect(view.lists[0]!.pending).toBe(1);
    expect(view.lists[0]!.tasks.map((task) => task.title)).toEqual(['A 未发送的编辑']);

    // Adoption writes the binding, so the compatibility path is one-time.
    const claimed = await store.bindAccount!(ACCOUNT_A.account, ACCOUNT_A.account.email);
    expect(claimed).toBe(true);
    expect(await store.boundAccount!()).toEqual({
      email: ACCOUNT_A.account.email,
      apiUrl: ACCOUNT_A.account.apiUrl,
    });

    // And the queued op is still there: adoption never drops offline work.
    const ops = await store.transact((tx) => tx.ops(LIST_ID));
    expect(ops.map((op) => op.status)).toEqual(['pending']);
  });

  it('still keeps a bound space readable for its account after sign-out', async () => {
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await seedLegacy(store, LIST_ID);
    await bindPersonal(repository, ACCOUNT_A);
    // Give the space a real binding first, then sign out.
    expect(await store.bindAccount!(ACCOUNT_A.account, ACCOUNT_A.account.email)).toBe(true);

    const session: { current: SharedSession | null } = { current: null };
    const engine = engineFor(repository, store, session);
    const view = await engine.read();
    expect(view.lists.map((item) => item.record.summary.name)).toEqual(['A 的旧清单']);

    // B signing in on the same profile still sees nothing.
    session.current = ACCOUNT_B;
    expect(await engine.read()).toEqual({ lists: [], invitations: [] });
  });
});
