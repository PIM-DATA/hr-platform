import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/hooks/useAuth';
import { ToastProvider } from '@/components/ui/Toast';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

/** App-wide providers. AuthProvider bootstraps the session via GET /auth/me. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
