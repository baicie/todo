import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mobileQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export { mobileQueryClient as queryClient };
export { QueryClientProvider };
