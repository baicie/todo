import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';

interface AppDnDContextValue {
  draggingTaskId: string | null;
  startTaskDrag: (taskId: string) => void;
  endTaskDrag: () => void;
  overTargetId: string | null;
  setOverTargetId: (id: string | null) => void;
}

const AppDnDContext = createContext<AppDnDContextValue | null>(null);

export function AppDnDProvider({ children }: { children: ReactNode }) {
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [overTargetId, setOverTargetId] = useState<string | null>(null);

  const startTaskDrag = useCallback((taskId: string) => {
    setDraggingTaskId(taskId);
  }, []);

  const endTaskDrag = useCallback(() => {
    setDraggingTaskId(null);
    setOverTargetId(null);
  }, []);

  return (
    <AppDnDContext.Provider
      value={{ draggingTaskId, startTaskDrag, endTaskDrag, overTargetId, setOverTargetId }}
    >
      {children}
    </AppDnDContext.Provider>
  );
}

export function useAppDnD() {
  const ctx = useContext(AppDnDContext);
  if (!ctx) throw new Error('useAppDnD must be used within AppDnDProvider');
  return ctx;
}
