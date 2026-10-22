import type { ExportBundle } from './ports';

export function toCsv(bundle: ExportBundle): string {
  const listNames = new Map(bundle.lists.map((list) => [list.id, list.name]));
  const headers = [
    '标题',
    '状态',
    '清单',
    '标签',
    '重要',
    '截止日期',
    '提醒时间',
    '重复规则',
    '备注',
    '完成时间',
    '创建时间',
    'ID',
  ];
  const escape = (value: string | null | undefined): string => {
    const text = value ?? '';
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = bundle.tasks
    .filter((task) => !task.deletedAt)
    .map((task) =>
      [
        task.title,
        task.status === 'completed' ? '已完成' : '未完成',
        task.listId ? (listNames.get(task.listId) ?? '') : '收件箱',
        (task.tags ?? []).map((tag) => `#${tag}`).join(' '),
        task.important ? '是' : '否',
        task.dueOn,
        task.remindAt,
        task.recurrence ? JSON.stringify(task.recurrence) : '',
        task.note,
        task.completedAt,
        task.createdAt,
        task.id,
      ]
        .map(escape)
        .join(','),
    );
  return `\uFEFF${[headers.join(','), ...rows].join('\r\n')}`;
}

export function toIcs(bundle: ExportBundle, now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const escapeText = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const nextDay = (date: string): string => {
    const parsed = new Date(`${date}T00:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed.toISOString().slice(0, 10).replace(/-/g, '');
  };
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Shishi//To Do//CN',
    'CALSCALE:GREGORIAN',
  ];
  for (const task of bundle.tasks) {
    if (task.deletedAt || !task.dueOn) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${task.id}@shishi.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${task.dueOn.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${nextDay(task.dueOn)}`,
      `SUMMARY:${escapeText(task.title)}`,
    );
    if (task.note) lines.push(`DESCRIPTION:${escapeText(task.note)}`);
    if (task.tags && task.tags.length > 0) {
      lines.push(`CATEGORIES:${task.tags.map(escapeText).join(',')}`);
    }
    if (task.status === 'completed') lines.push('STATUS:COMPLETED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > 75) {
    chunks.push(remaining.slice(0, 75));
    remaining = ` ${remaining.slice(75)}`;
  }
  chunks.push(remaining);
  return chunks.join('\r\n');
}

export interface ImportedCalendarTask {
  title: string;
  note: string;
  dueOn: string;
}

/** Import VEVENTs as plain tasks. Unknown properties, alarms and attendees are ignored. */
export function fromIcs(text: string): ImportedCalendarTask[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
  const unescape = (value: string): string =>
    value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  return blocks.flatMap((block) => {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).split(';')[0]?.toUpperCase();
      if (name) fields.set(name, line.slice(colon + 1));
    }
    const title = unescape(fields.get('SUMMARY')?.trim() ?? '');
    const start = fields.get('DTSTART')?.trim() ?? '';
    const dueOn = /^\d{8}/.test(start)
      ? `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`
      : '';
    if (!title || !dueOn) return [];
    return [{ title, note: unescape(fields.get('DESCRIPTION') ?? ''), dueOn }];
  });
}

export function downloadBlob(content: BlobPart, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportFilename(extension: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return `shishi-backup-${stamp}.${extension}`;
}
