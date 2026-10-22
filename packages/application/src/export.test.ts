import { describe, expect, test } from 'vitest';
import { fromIcs, toCsv, toIcs } from './export';
import type { ExportBundle } from './ports';

const bundle: ExportBundle = {
  format: 'todo-export',
  version: 1,
  exportedAt: '2026-10-22T00:00:00.000Z',
  appVersion: '1.1.0',
  lists: [],
  steps: [],
  dayPlans: [],
  tasks: [
    {
      id: '00000000-0000-7000-8000-000000000001',
      listId: null,
      title: '提交周报',
      note: '包含,逗号与\n换行',
      tags: ['工作'],
      status: 'open',
      important: false,
      dueOn: '2026-10-23',
      remindAt: null,
      remindTimezone: null,
      rank: 'a0',
      seriesId: null,
      occurrenceKey: null,
      recurrence: null,
      completedAt: null,
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      deletedAt: null,
    },
  ],
};

describe('calendar export', () => {
  test('writes a VEVENT and imports it back', () => {
    const ics = toIcs(bundle, new Date('2026-10-22T00:00:00.000Z'));
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261023');
    expect(ics).toContain('CATEGORIES:工作');
    const imported = fromIcs(ics);
    expect(imported).toEqual([
      { title: '提交周报', note: '包含,逗号与\n换行', dueOn: '2026-10-23' },
    ]);
  });

  test('CSV includes tags', () => {
    expect(toCsv(bundle)).toContain('标签');
    expect(toCsv(bundle)).toContain('#工作');
  });
});
