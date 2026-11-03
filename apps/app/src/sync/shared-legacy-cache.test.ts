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
 * an account may read or adopt the legacy space only when both the personal
 * data space and the cached list snapshots prove the same account owns it.
 */

const NOW = '2026-11-01T00:00:00.000Z';
const OWNER_ID = '019a0000-0000-7000-8000-000000000001';
/** The list owner when the cached account was only invited to it. */
const INVITER_EMAIL = 'owner@example.com';
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

/**
 * Write the pre-binding shape: a list, a task and a queued op, no binding.
 *
 * `role` is the role this device's account had on the list. It matches what the
 * server records for that member, which is what the compatibility rule checks.
 */
async function seedLegacy(
  store: SharedStore,
  listId: string,
  {
    ownerEmail = ACCOUNT_A.account.email,
    role = 'owner',
  }: { ownerEmail?: string; role?: 'owner' | 'editor' | 'viewer' } = {},
): Promise<void> {
  const summary = {
    id: listId,
    owner_id: OWNER_ID,
    name: 'A 的旧清单',
    color: null,
    icon: null,
    rank: 'a0',
    revision: 1,
    role,
    created_at: NOW,
    updated_at: NOW,
  };
  const record: SharedListRecord = {
    id: listId,
    summary,
    // The legacy release stored the server snapshot with it. The member table
    // is the only historical evidence that ties this cache to an email.
    snapshot: {
      members: [
        // The owner is always someone else on an invited list; on an owned list
        // it is the cached account itself. The rule reads the entry for the
        // signed-in email, so both shapes are exercised.
        {
          user_id: OWNER_ID,
          email: role === 'owner' ? ownerEmail : INVITER_EMAIL,
          role: 'owner',
          created_at: NOW,
        },
        {
          user_id: '019a0000-0000-7000-8000-000000000002',
          email: ownerEmail,
          role,
          created_at: NOW,
        },
      ],
      invitations: [],
      tasks: [],
      steps: [],
    },
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
    await tx.setMeta(
      'invitations',
      JSON.stringify([
        {
          id: '019b3000-0000-7000-8000-000000000001',
          list_id: listId,
          list_name: 'A 的旧清单',
          email: ownerEmail,
          role: 'editor',
          status: 'pending',
          invited_by: '019a0000-0000-7000-8000-000000000009',
          invited_by_email: INVITER_EMAIL,
          revision: 1,
          created_at: NOW,
          updated_at: NOW,
        },
      ]),
    );
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
    expect(view.invitations.map((invitation) => invitation.email)).toEqual([
      ACCOUNT_A.account.email,
    ]);

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

  it('does not let another logged-in account claim the legacy cache or replay its outbox', async () => {
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await seedLegacy(store, LIST_ID);

    // B has completed a real login on this data space, which is exactly the
    // weak signal the earlier fix accepted as proof of ownership.
    await bindPersonal(repository, ACCOUNT_B);
    let requests = 0;
    const session: { current: SharedSession | null } = { current: ACCOUNT_B };
    const b = new SharedSyncEngine({
      request: () => {
        requests += 1;
        throw new TypeError('Failed to fetch');
      },
      store,
      session: () => session.current,
      ownerHint: async () => (await repository.syncGetDiagnostics()).boundAccount,
    });

    expect(await b.read()).toEqual({ lists: [], invitations: [] });
    b.start();
    await b.syncNow();
    b.stop();
    expect(requests).toBe(0);
    expect(await store.boundAccount!()).toBeNull();
    expect((await store.transact((tx) => tx.ops(LIST_ID))).map((op) => op.status)).toEqual([
      'pending',
    ]);
    await expect(b.createTask(LIST_ID, { title: 'B 不能写进 A 的空间' })).rejects.toThrow(
      '另一个账号',
    );

    // The owner can still claim the same bytes once their own login binds the
    // personal data space. Nothing in the cache was erased for B's session.
    await bindPersonal(repository, ACCOUNT_A);
    expect(await store.bindAccount!(ACCOUNT_A.account, ACCOUNT_A.account.email)).toBe(true);
    expect((await store.transact((tx) => tx.ops(LIST_ID))).map((op) => op.status)).toEqual([
      'pending',
    ]);
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

  it('keeps a legacy cache readable for an account that was only invited to the list', async () => {
    // The owner-only version of this rule locked a legitimate editor out of
    // their entire cache - lists and unsent outbox alike - because the snapshot
    // owner is somebody else. `summary.role` is this device's own role.
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await seedLegacy(store, LIST_ID, { role: 'editor' });
    await bindPersonal(repository, ACCOUNT_A);

    const session: { current: SharedSession | null } = { current: ACCOUNT_A };
    const engine = engineFor(repository, store, session);

    const view = await engine.read();
    expect(view.lists.map((item) => item.record.summary.name)).toEqual(['A 的旧清单']);
    expect(view.lists[0]!.tasks.map((task) => task.title)).toEqual(['A 未发送的编辑']);

    // Adoption applies the same rule, so the queue is not stranded either.
    expect(await store.bindAccount!(ACCOUNT_A.account, ACCOUNT_A.account.email)).toBe(true);
    expect((await store.transact((tx) => tx.ops(LIST_ID))).map((op) => op.status)).toEqual([
      'pending',
    ]);
  });

  it('refuses a legacy cache whose snapshots disagree with the recorded role', async () => {
    // Membership alone is not evidence: two accounts see the same member table.
    // The role the cache records for this device is the tie-breaker, so a
    // snapshot that does not carry the account in that role proves nothing.
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await seedLegacy(store, LIST_ID, { role: 'editor' });

    // Rewrite the summary to claim ownership while the snapshot still lists
    // this account as an editor. The two disagree, so the space is refused.
    await store.transact(async (tx) => {
      const record = await tx.getList(LIST_ID);
      await tx.putList({ ...record!, summary: { ...record!.summary, role: 'owner' } });
    });
    await bindPersonal(repository, ACCOUNT_A);

    const session: { current: SharedSession | null } = { current: ACCOUNT_A };
    const engine = engineFor(repository, store, session);
    expect(await engine.read()).toEqual({ lists: [], invitations: [] });
    expect(await store.bindAccount!(ACCOUNT_A.account, ACCOUNT_A.account.email)).toBe(false);
    expect(await store.boundAccount!()).toBeNull();
  });

  it('refuses an unbound cache whose invitations name another account', async () => {
    // The invitation index is fetched with the signed-in token and names its
    // invitee, so it is attributable on its own - even when no list is cached.
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    await store.transact((tx) =>
      tx.setMeta(
        'invitations',
        JSON.stringify([
          {
            id: '019b3000-0000-7000-8000-000000000002',
            list_id: LIST_ID,
            list_name: '别人的清单',
            email: ACCOUNT_B.account.email,
            role: 'editor',
            status: 'pending',
            invited_by: OWNER_ID,
            invited_by_email: INVITER_EMAIL,
            revision: 1,
            created_at: NOW,
            updated_at: NOW,
          },
        ]),
      ),
    );
    await bindPersonal(repository, ACCOUNT_A);

    const session: { current: SharedSession | null } = { current: ACCOUNT_A };
    const engine = engineFor(repository, store, session);
    expect(await engine.read()).toEqual({ lists: [], invitations: [] });
    expect(await store.bindAccount!(ACCOUNT_A.account, ACCOUNT_A.account.email)).toBe(false);
  });

  it('still claims a brand-new empty space without any owner hint', async () => {
    // The legacy rule must not turn into "no space is ever created": an empty
    // cache carries nothing to attribute and belongs to the account that made it.
    const repository = newRepository();
    await repository.initialize();
    const store = legacyStore(repository);
    expect(await store.boundAccount!()).toBeNull();

    expect(await store.bindAccount!(ACCOUNT_A.account, null)).toBe(true);
    expect(await store.boundAccount!()).toEqual({
      email: ACCOUNT_A.account.email,
      apiUrl: ACCOUNT_A.account.apiUrl,
    });

    // A space that does hold data is still refused without the hint, so the
    // empty-space path cannot be used to take over an existing cache.
    const seeded = legacyStore(newRepository());
    await seedLegacy(seeded, LIST_ID);
    expect(await seeded.bindAccount!(ACCOUNT_A.account, null)).toBe(false);
    expect(await seeded.boundAccount!()).toBeNull();
  });
});
