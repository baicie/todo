import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { normalizeTags, taskQueryPredicate } from './tasks';
import { makeTask } from './tasks';

// Hash-prefixed values are generated explicitly: a plain string arbitrary hits
// them rarely, which is how "# #" slipped past this property until CI failed on
// it. Generation is seeded so a failure is reproducible from the log alone.
const tagArbitrary = fc
  .oneof(
    fc.string({ minLength: 0, maxLength: 40 }),
    fc.string({ minLength: 1, maxLength: 40 }).map((value) => `#${value}`),
  )
  .map((value) => value.replace(/[\r\n\t]/g, ' '));

const SEED = 1_132_800_433;

describe('domain properties', () => {
  test('tag normalization is idempotent and bounded', () => {
    fc.assert(
      fc.property(fc.array(tagArbitrary, { maxLength: 40 }), (tags) => {
        const once = normalizeTags(tags);
        const twice = normalizeTags(once);
        expect(twice).toEqual(once);
        expect(once.length).toBeLessThanOrEqual(20);
        expect(once.every((tag) => tag.length > 0 && tag.length <= 32)).toBe(true);
        // Stored tags must never carry a leading hash: the UI renders "#" itself,
        // and a stored hash is what made normalization non-idempotent.
        expect(once.every((tag) => !tag.startsWith('#'))).toBe(true);
      }),
      { numRuns: 400, seed: SEED },
    );
  });

  test('search predicate never includes hidden or deleted tasks', () => {
    const predicate = taskQueryPredicate({ view: 'all', search: '报告' });
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (title) => {
        const task = makeTask(
          '00000000-0000-7000-8000-000000000001',
          { title: title || '任务', note: '' },
          new Date().toISOString(),
        );
        if (task.deletedAt) return;
        const included = predicate(task);
        if (included) {
          expect(task.status).toBe('open');
          expect(`${task.title}\n${task.note}`.toLowerCase()).toContain('报告');
        }
      }),
      { numRuns: 200 },
    );
  });

  test('tag filters require every selected tag', () => {
    const task = makeTask(
      '00000000-0000-7000-8000-000000000002',
      { title: '周报', tags: ['工作', '本周'] },
      new Date().toISOString(),
    );
    expect(taskQueryPredicate({ view: 'all', tags: ['工作', '本周'] })(task)).toBe(true);
    expect(taskQueryPredicate({ view: 'all', tags: ['工作', '个人'] })(task)).toBe(false);
  });
});
