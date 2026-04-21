import { useState } from 'react';
import { AuthProvider, useExtAuth } from '../contexts/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { TaskList } from './pages/TaskList';

function AppContent() {
  const { user } = useExtAuth();
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
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
