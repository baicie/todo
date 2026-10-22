import type { TaskWithSteps } from '@todo/domain';

const TEMPLATES_KEY = 'shishi.templates.v1';

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  note: string;
  tags: string[];
  important: boolean;
  dueOffsetDays: number | null;
  steps: string[];
  createdAt: string;
}

export function loadTemplates(): TaskTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TaskTemplate[]) : [];
  } catch {
    return [];
  }
}

export function persistTemplates(templates: TaskTemplate[]): void {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
  } catch {
    // Private browsing can reject storage; the in-memory list still works.
  }
}

export function templateFromTask(task: TaskWithSteps, today: string, name: string): TaskTemplate {
  let dueOffsetDays: number | null = null;
  if (task.dueOn) {
    const due = new Date(`${task.dueOn}T00:00:00Z`).getTime();
    const base = new Date(`${today}T00:00:00Z`).getTime();
    dueOffsetDays = Math.round((due - base) / 86_400_000);
  }
  return {
    id: crypto.randomUUID(),
    name: name.trim() || task.title,
    title: task.title,
    note: task.note,
    tags: task.tags ?? [],
    important: task.important,
    dueOffsetDays,
    steps: task.steps.map((step) => step.title),
    createdAt: new Date().toISOString(),
  };
}
