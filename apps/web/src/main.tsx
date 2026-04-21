import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import './index.css';
import './i18n';
import { queryClient, switchStorageMode } from '@baicie/orbit-hooks';
import { AuthProvider } from './contexts/AuthContext';

// Initialize storage with environment API URL when in remote mode
const apiUrl = import.meta.env.VITE_API_URL;
if (apiUrl) {
  switchStorageMode('remote', apiUrl);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
