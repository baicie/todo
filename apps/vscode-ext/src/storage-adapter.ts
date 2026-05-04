import type { Task } from '@baicie/orbit';
import { LocalStorage } from '@baicie/orbit';

let storageInstance: LocalStorage | null = null;

function getVscodeStorage(): LocalStorage {
  if (!storageInstance) {
    storageInstance = new LocalStorage({ mode: 'local' });
  }
  return storageInstance;
}

export async function getTasks(): Promise<Task[]> {
  const storage = getVscodeStorage();
  return storage.tasks.getTasks();
}

export async function createTask(title: string): Promise<Task> {
  const storage = getVscodeStorage();
  return storage.tasks.createTask({ title });
}

export async function updateTask(taskId: string, updates: Partial<Task>): Promise<void> {
  const storage = getVscodeStorage();
  await storage.tasks.updateTask(taskId, updates);
}

export async function deleteTask(taskId: string): Promise<void> {
  const storage = getVscodeStorage();
  await storage.tasks.deleteTask(taskId);
}
