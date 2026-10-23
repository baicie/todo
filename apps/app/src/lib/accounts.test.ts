import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeAccountId,
  adoptNativeAccountContext,
  cloudConfigKey,
  loadAccountProfiles,
} from './accounts';

describe('native account context adoption', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the default account without touching legacy config', () => {
    localStorage.setItem('shishi.cloud.config', '{"email":"a@example.com"}');
    localStorage.setItem('shishi.active-account.v1', 'stale-target');
    adoptNativeAccountContext({
      accountId: 'default',
      kind: 'anonymous',
      email: null,
      migratedFromLegacy: true,
    });
    expect(activeAccountId()).toBe('default');
    expect(localStorage.getItem('shishi.cloud.config')).toBe('{"email":"a@example.com"}');
  });

  it('migrates a matching legacy config to the opaque account key', () => {
    const id = '01a1673d-1000-7000-8000-000000000010';
    localStorage.setItem(
      'shishi.cloud.config',
      JSON.stringify({ email: 'User@Example.com', apiUrl: 'https://api.example', enabled: true }),
    );
    adoptNativeAccountContext({
      accountId: id,
      kind: 'cloud',
      email: 'user@example.com',
      migratedFromLegacy: true,
    });
    expect(activeAccountId()).toBe(id);
    expect(cloudConfigKey(id)).toBe(`shishi.cloud.config.${id}`);
    expect(JSON.parse(localStorage.getItem(cloudConfigKey(id))!)).toMatchObject({
      email: 'User@Example.com',
      apiUrl: 'https://api.example',
    });
    expect(loadAccountProfiles()).toEqual([
      expect.objectContaining({ id, email: 'user@example.com' }),
    ]);
  });

  it('adopts the native target account and its per-account cloud config', () => {
    const id = '01a1673d-1000-7000-8000-000000000012';
    localStorage.setItem('shishi.active-account.v1', 'default');
    localStorage.setItem(
      cloudConfigKey(id),
      JSON.stringify({ email: 'b@example.com', apiUrl: 'https://b.example', enabled: false }),
    );
    adoptNativeAccountContext({
      accountId: id,
      kind: 'cloud',
      email: 'b@example.com',
      migratedFromLegacy: false,
    });
    expect(activeAccountId()).toBe(id);
    expect(loadAccountProfiles()).toEqual([
      expect.objectContaining({ id, email: 'b@example.com', apiUrl: 'https://b.example' }),
    ]);
  });

  it('does not copy legacy config when the verified email differs', () => {
    const id = '01a1673d-1000-7000-8000-000000000011';
    localStorage.setItem(
      'shishi.cloud.config',
      JSON.stringify({ email: 'other@example.com', apiUrl: 'https://api.example' }),
    );
    adoptNativeAccountContext({
      accountId: id,
      kind: 'cloud',
      email: 'user@example.com',
      migratedFromLegacy: true,
    });
    expect(activeAccountId()).toBe(id);
    expect(localStorage.getItem(cloudConfigKey(id))).toBeNull();
  });
});
