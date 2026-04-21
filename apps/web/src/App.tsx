import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { MainContent } from './components/MainContent';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { useAuth } from './contexts/AuthContext';
import type { JSX } from 'react';

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--theme-primary)]"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/tasks/my-day" replace />} />
          <Route path="tasks/:listId" element={<MainContent />} />
        </Route>
      </Routes>
      <PWAInstallPrompt />
    </BrowserRouter>
  );
}

export default App;
