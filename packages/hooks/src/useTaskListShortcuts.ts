import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '@baicie/orbit';

export interface TaskListShortcutsParams {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onToggleComplete: (task: Task) => void;
  onToggleImportant: (task: Task) => void;
  onToggleMyDay: (task: Task) => void;
  onDeleteTask: (id: string) => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onAddTask: () => void;
  onNavigate: (path: string) => void;
}

export interface TaskListShortcutsReturn {
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
}

function isInputElement(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function useTaskListShortcuts(params: TaskListShortcutsParams): TaskListShortcutsReturn {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [focusedIndex, setFocusedIndex] = useState(-1);

  const selectTask = useCallback((index: number) => {
    const { tasks, onSelectTask } = paramsRef.current;
    const activeTasks = tasks.filter((t) => !t.isCompleted);
    if (index >= 0 && index < activeTasks.length) {
      setFocusedIndex(index);
      onSelectTask(activeTasks[index].id);
    }
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _moveFocus = useCallback((delta: number) => {
    const { tasks, onSelectTask } = paramsRef.current;
    const activeTasks = tasks.filter((t) => !t.isCompleted);
    if (activeTasks.length === 0) return;
    setFocusedIndex((prev) => {
      const next = Math.max(0, Math.min(prev + delta, activeTasks.length - 1));
      onSelectTask(activeTasks[next].id);
      return next;
    });
  }, []);

  useEffect(() => {
    let currentFocusedIndex = -1;

    function handleKeyDown(e: KeyboardEvent) {
      const {
        selectedTaskId,
        tasks,
        onSelectTask: _onSelectTask,
        onToggleComplete,
        onToggleImportant,
        onToggleMyDay,
        onDeleteTask,
        onOpenCommandPalette,
        onOpenSettings,
        onOpenSearch,
        onAddTask,
        onNavigate,
      } = paramsRef.current;
      void _onSelectTask;
      const activeTasks = tasks.filter((t) => !t.isCompleted);
      const target = e.target as HTMLElement;
      const inInput = isInputElement(target);

      // Global shortcuts (work everywhere)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenCommandPalette();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        onOpenSearch();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        onOpenSettings();
        return;
      }

      // Esc: deselect
      if (e.key === 'Escape') {
        setFocusedIndex(-1);
        currentFocusedIndex = -1;
        paramsRef.current.onSelectTask(null);
        return;
      }

      // Task-level shortcuts (don't work in input fields)
      if (inInput) return;

      // N: New task
      if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onAddTask();
        return;
      }

      // Arrow navigation
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentFocusedIndex < 0) {
          selectTask(0);
          currentFocusedIndex = 0;
        } else {
          const next = Math.min(currentFocusedIndex + 1, activeTasks.length - 1);
          selectTask(next);
          currentFocusedIndex = next;
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentFocusedIndex < 0) {
          selectTask(activeTasks.length - 1);
          currentFocusedIndex = activeTasks.length - 1;
        } else {
          const next = Math.max(currentFocusedIndex - 1, 0);
          selectTask(next);
          currentFocusedIndex = next;
        }
        return;
      }

      // Tab navigation
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          if (currentFocusedIndex > 0) {
            currentFocusedIndex--;
            selectTask(currentFocusedIndex);
          }
        } else {
          if (currentFocusedIndex < activeTasks.length - 1) {
            currentFocusedIndex++;
            selectTask(currentFocusedIndex);
          }
        }
        return;
      }

      // Smart list shortcuts (1-4)
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '1') {
          onNavigate('/tasks/my-day');
          return;
        }
        if (e.key === '2') {
          onNavigate('/tasks/important');
          return;
        }
        if (e.key === '3') {
          onNavigate('/tasks/planned');
          return;
        }
        if (e.key === '4') {
          onNavigate('/tasks/tasks');
          return;
        }
      }

      // Task operations (only when a task is selected)
      if (!selectedTaskId) return;
      const selectedTask = tasks.find((t) => t.id === selectedTaskId);
      if (!selectedTask) return;

      if (e.key === ' ') {
        e.preventDefault();
        onToggleComplete(selectedTask);
        return;
      }
      if (e.key.toLowerCase() === 'i') {
        e.preventDefault();
        onToggleImportant(selectedTask);
        return;
      }
      if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        onToggleMyDay(selectedTask);
        return;
      }
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        onDeleteTask(selectedTaskId);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectTask]);

  return { focusedIndex, setFocusedIndex };
}
