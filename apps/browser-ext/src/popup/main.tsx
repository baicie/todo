import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { PopupApp } from '../app/PopupApp';
import { queryClient } from '@baicie/orbit-hooks';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PopupApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
