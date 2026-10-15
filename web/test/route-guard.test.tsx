import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import AppLayout from "@/layouts/AppLayout";
import { renderApp } from "./render";
import { server } from "./server";
import { historyMock, locationMock } from "./setup";

beforeEach(() => {
  historyMock.replace.mockReset();
  locationMock.pathname = "/overview";
});

test("未初始化访问后台时路由守卫跳转 setup", async () => {
  server.use(
    http.get("/api/setup/status", () => HttpResponse.json({ required: true })),
  );
  renderApp(<AppLayout />);
  await waitFor(() =>
    expect(historyMock.replace).toHaveBeenCalledWith("/setup"),
  );
});

test("无 users.manage 时用户管理路由显示 403", async () => {
  locationMock.pathname = "/users";
  server.use(
    http.get("/api/setup/status", () => HttpResponse.json({ required: false })),
    http.get("/api/me", () =>
      HttpResponse.json({
        user: {
          id: "u1",
          username: "viewer",
          displayName: "Viewer",
          accountType: "human",
          roleId: "viewer",
          disabled: false,
          forcePasswordChange: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        role: {
          id: "viewer",
          name: "只读成员",
          builtIn: true,
          permissions: ["system.read"],
          targetAllow: ["*"],
          targetDeny: [],
        },
        permissions: ["system.read"],
        csrfToken: "csrf",
      }),
    ),
  );
  renderApp(<AppLayout />);
  expect(await screen.findByText("无权访问此页面")).toBeInTheDocument();
});
