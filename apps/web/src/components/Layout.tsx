import { SortableSidebar } from './SortableSidebar';
import { Header } from './Header';
import { Outlet } from 'react-router-dom';
import { OfflineIndicator } from './OfflineIndicator';
import { useAppDnD } from '../contexts/AppDnDContext';
import { useTaskDropHandler } from '../hooks/useTaskDropHandler';

export const Layout = () => {
  const { draggingTaskId, endTaskDrag } = useAppDnD();
  useTaskDropHandler();

  const handleTaskDrop = (taskId: string, listId: string) => {
    window.dispatchEvent(new CustomEvent('task-drop-to-list', { detail: { taskId, listId } }));
    endTaskDrag();
  };

  return (
    <>
      <a href="#main-content" className="skip-link">
        跳过导航
      </a>
      <div className="flex flex-col w-screen h-screen overflow-hidden bg-white text-gray-900 font-sans">
        <OfflineIndicator />
        <Header />
        <div className="flex flex-1 overflow-hidden">
          <SortableSidebar
            draggingTask={draggingTaskId ? { id: draggingTaskId } : null}
            onTaskDrop={handleTaskDrop}
          />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 flex flex-col overflow-hidden focus:outline-none"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
};
