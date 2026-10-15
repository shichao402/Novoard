import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import type { ReactElement } from "react";

export function renderApp(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return {
    queryClient,
    ...render(
      <ConfigProvider>
        <App>
          <QueryClientProvider client={queryClient}>
            {element}
          </QueryClientProvider>
        </App>
      </ConfigProvider>,
    ),
  };
}
