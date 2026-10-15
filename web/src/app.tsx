import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import "./global.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 10_000,
    },
    mutations: {
      retry: false,
    },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={{ cssVar: { key: "novoard" } }}>
      <App>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </App>
    </ConfigProvider>
  );
}
