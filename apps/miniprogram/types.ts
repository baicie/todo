// Local todo item type for miniprogram (local-only, offline-first)
export interface TodoItem {
  id: string;
  title: string;
  isCompleted: boolean;
  isImportant: boolean;
  addToMyDay: boolean;
  dueDate: string | null;
  steps: { id: string; title: string; isCompleted: boolean }[];
  createdAt: string;
  updatedAt: string;
}

export function createTask(title: string, addToMyDay = false): TodoItem {
  return {
    id: Date.now().toString(),
    title,
    isCompleted: false,
    isImportant: false,
    addToMyDay,
    dueDate: null,
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
