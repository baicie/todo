import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import './i18n';
import { queryClient, switchStorageMode } from '@baicie/orbit-hooks';
import { AuthProvider } from './contexts/AuthContext';

const apiUrl = import.meta.env.VITE_API_URL;
if (apiUrl) {
  switchStorageMode('remote', apiUrl);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
