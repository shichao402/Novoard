import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import PatsPage from "@/pages/pats";
import RolesPage from "@/pages/roles";
import UsersPage from "@/pages/users";
import { renderApp } from "./render";
import { server } from "./server";

const role = {
  id: "superadmin",
  name: "超级管理员",
  builtIn: true,
  permissions: [
    "system.read",
    "users.manage",
    "roles.manage",
    "pats.self.manage",
  ],
  targetAllow: ["*"],
  targetDeny: [],
};

beforeEach(() => {
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({
        user: {
          id: "u1",
          username: "owner",
          displayName: "Owner",
          accountType: "human",
          roleId: "superadmin",
          disabled: false,
          forcePasswordChange: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        role,
        permissions: role.permissions,
        csrfToken: "csrf",
      }),
    ),
    http.get("/api/users", () => HttpResponse.json({ users: [] })),
    http.get("/api/roles", () => HttpResponse.json({ roles: [role] })),
    http.get("/api/pats", () => HttpResponse.json({ pats: [] })),
  );
});

test("用户创建表单使用标准 ProForm 字段", async () => {
  renderApp(<UsersPage />);
  await userEvent.click(
    await screen.findByRole("button", { name: "创建用户" }),
  );
  expect(await screen.findByLabelText("用户名")).toBeInTheDocument();
  expect(screen.getByLabelText("临时口令")).toBeInTheDocument();
  expect(screen.getByText("首次登录强制改密")).toBeInTheDocument();
});

test("角色表单暴露权限目录和 target allow/deny", async () => {
  renderApp(<RolesPage />);
  await userEvent.click(
    await screen.findByRole("button", { name: "创建角色" }),
  );
  expect(await screen.findByLabelText("角色 ID")).toBeInTheDocument();
  expect(screen.getByText("业务权限")).toBeInTheDocument();
  expect(screen.getByText("允许的 Target 范围")).toBeInTheDocument();
});

test("PAT 表单明确 scopes、target 范围和一次性明文流程", async () => {
  renderApp(<PatsPage />);
  await userEvent.click(
    await screen.findByRole("button", { name: "创建 PAT" }),
  );
  expect(await screen.findByLabelText("名称")).toBeInTheDocument();
  expect(screen.getByLabelText("Scopes")).toBeInTheDocument();
  expect(screen.getByLabelText("Target Allow")).toBeInTheDocument();
});
