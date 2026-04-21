import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@baicie/orbit-hooks';
import { LoginPage } from './pages/LoginPage';
import { TaskList } from './pages/TaskList';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

function AppContent() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<'all' | 'today' | 'important'>('all');

  if (!user) {
    return <LoginPage />;
  }

  return (
    <div className="w-[360px] h-[480px] flex flex-col bg-gray-50 overflow-hidden">
      <TaskList filter={filter} onFilterChange={setFilter} />
    </div>
  );
}

export function PopupApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
