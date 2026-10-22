import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonthsClamped,
  isDateOnly,
  nextOccurrence,
  normalizeRecurrence,
  parseQuickAdd,
  todayInTimeZone,
  weekdayIso,
  zonedDateTimeToUtc,
} from '../src';

describe('date semantics', () => {
  it('validates real calendar dates and rejects impossible dates', () => {
    expect(isDateOnly('2026-10-21')).toBe(true);
    expect(isDateOnly('2026-02-29')).toBe(false);
    expect(isDateOnly('2026-13-01')).toBe(false);
  });

  it('computes the account-local date across the UTC midnight boundary', () => {
    expect(todayInTimeZone('Asia/Shanghai', new Date('2026-10-20T16:30:00Z'))).toBe('2026-10-21');
    expect(todayInTimeZone('America/Los_Angeles', new Date('2026-10-21T02:00:00Z'))).toBe(
      '2026-10-20',
    );
  });

  it('uses calendar arithmetic rather than fixed 24 hour days', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(weekdayIso('2026-10-21')).toBe(3);
  });

  it('converts wall-clock time in an IANA zone across DST', () => {
    expect(zonedDateTimeToUtc('2026-03-08T09:00', 'America/Los_Angeles')).toBe(
      '2026-03-08T16:00:00.000Z',
    );
    expect(zonedDateTimeToUtc('2026-11-01T09:00', 'America/Los_Angeles')).toBe(
      '2026-11-01T17:00:00.000Z',
    );
  });
});

describe('recurrence', () => {
  it('advances daily rules by calendar day', () => {
    expect(
      nextOccurrence({ frequency: 'daily', interval: 1, anchorMode: 'calendar' }, '2026-03-07'),
    ).toBe('2026-03-08');
  });

  it('skips weekends for weekday rules', () => {
    expect(
      nextOccurrence({ frequency: 'weekdays', interval: 1, anchorMode: 'calendar' }, '2026-10-23'),
    ).toBe('2026-10-26');
  });

  it('finds the next selected weekday across a week boundary', () => {
    expect(
      nextOccurrence(
        { frequency: 'weekly', interval: 1, weekdays: [1, 3], anchorMode: 'calendar' },
        '2026-10-21',
      ),
    ).toBe('2026-10-26');
  });

  it('skips months that do not contain the requested day', () => {
    expect(
      nextOccurrence(
        { frequency: 'monthly', interval: 1, monthDay: 31, anchorMode: 'calendar' },
        '2026-01-31',
      ),
    ).toBe('2026-03-31');
  });

  it('skips non-leap years for February 29', () => {
    expect(
      nextOccurrence(
        {
          frequency: 'yearly',
          interval: 1,
          month: 2,
          monthDay: 29,
          anchorMode: 'calendar',
        },
        '2026-02-28',
      ),
    ).toBe('2028-02-29');
  });

  it('requires a weekday for weekly rules', () => {
    expect(() => normalizeRecurrence({ frequency: 'weekly' })).toThrow();
  });
});

describe('quick add parsing', () => {
  it('extracts a list, importance and a relative due date without losing the title', () => {
    const parsed = parseQuickAdd(
      '明天 提交报销单 #工作 !',
      '2026-10-21',
      [
        {
          id: 'list-work',
          name: '工作',
          color: null,
          icon: null,
          rank: '1',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
        },
      ],
      null,
    );
    expect(parsed.title).toBe('提交报销单');
    expect(parsed.dueOn).toBe('2026-10-22');
    expect(parsed.listId).toBe('list-work');
    expect(parsed.important).toBe(true);
  });
});
