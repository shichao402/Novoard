/**
 * 成员页数据来源回归：
 * 1. 单一 /api/members 端点，不再有独立的 /api/agent-credentials 前端 join；
 * 2. "已签发但从未接入"的成员必须出现在表里，且可以直接吊销。
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import MembersPage from "@/pages/members";
import { renderApp } from "./render";
import { server } from "./server";

const superadmin = {
  id: "superadmin",
  name: "超级管理员",
  builtIn: true,
  permissions: ["system.read", "targets.read", "users.manage"],
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
        role: superadmin,
        permissions: superadmin.permissions,
        csrfToken: "csrf",
      }),
    ),
  );
});

test("未接入成员与在线成员同表可见，并可直接吊销", async () => {
  let deleted = "";
  server.use(
    http.get("/api/members", () =>
      HttpResponse.json({
        members: [
          {
            agentId: "win-dev",
            name: "Windows 开发机",
            online: false,
            registered: false,
            skillCount: 0,
            skills: [],
            credentials: {
              configured: true,
              lastFour: "9f3a",
              issuedAt: "2026-10-14T02:00:00Z",
              rotatedAt: null,
              createdAt: "2026-10-14T02:00:00Z",
            },
          },
          {
            agentId: "mac-work",
            name: "工位 Mac",
            online: true,
            registered: true,
            skillCount: 1,
            skills: [{ id: "dev-build-investm", name: "构建 InvestM dev" }],
            credentials: {
              configured: true,
              lastFour: "1c2d",
              issuedAt: "2026-10-12T02:00:00Z",
              rotatedAt: null,
              createdAt: "2026-10-12T02:00:00Z",
            },
          },
        ],
      }),
    ),
    http.delete("/api/members/:agentId", ({ params }) => {
      deleted = String(params.agentId);
      return HttpResponse.json({ ok: true, agentId: deleted, removed: true });
    }),
  );

  renderApp(<MembersPage />);

  const orphanRow = (await screen.findByText("win-dev")).closest("tr");
  expect(orphanRow).not.toBeNull();
  // 身份在、从未接入：状态必须是"未接入"，且凭据区可见、可吊销
  expect(
    within(orphanRow as HTMLElement).getByText("未接入"),
  ).toBeInTheDocument();
  expect(
    within(orphanRow as HTMLElement).getByText("已签发"),
  ).toBeInTheDocument();
  expect(
    within(orphanRow as HTMLElement).getByText("…9f3a"),
  ).toBeInTheDocument();

  const revokeButton = within(orphanRow as HTMLElement).getByRole("button", {
    name: /吊\s*销/,
  });
  await userEvent.click(revokeButton);
  await userEvent.click(await screen.findByRole("button", { name: /确\s*定/ }));

  await waitFor(() => expect(deleted).toBe("win-dev"));
});

test("未签发凭据的成员只显示签发入口，没有吊销按钮", async () => {
  server.use(
    http.get("/api/members", () =>
      HttpResponse.json({
        members: [
          {
            agentId: "mac-home",
            name: "家中 Mac",
            online: true,
            registered: true,
            skillCount: 1,
            skills: [{ id: "dev-build-investm", name: "构建 InvestM dev" }],
            credentials: {
              configured: false,
              lastFour: null,
              issuedAt: null,
              rotatedAt: null,
              createdAt: null,
            },
          },
        ],
      }),
    ),
  );

  renderApp(<MembersPage />);

  const row = (await screen.findByText("mac-home")).closest("tr");
  expect(within(row as HTMLElement).getByText("未签发")).toBeInTheDocument();
  const labels = within(row as HTMLElement)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
  expect(labels.some((label) => label.includes("签发"))).toBe(true);
  expect(labels.some((label) => label.includes("吊销"))).toBe(false);
});
