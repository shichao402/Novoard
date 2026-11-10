/**
 * 能力包来源页（PRD-6 H3）：
 * 1. 新增时输入一次 id，非法 id 实时提示，不发请求；
 * 2. 编辑、删除在列表行上操作，不再输入 id。
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import PackSourcesPage from "@/pages/pack-sources";
import { renderApp } from "./render";
import { server } from "./server";

const role = {
  id: "superadmin",
  name: "超级管理员",
  builtIn: true,
  permissions: ["system.read", "targets.read", "users.manage"],
  targetAllow: ["*"],
  targetDeny: [],
};

type Source = { id: string; git: string; branch: string; subdir?: string };
let sources: Source[] = [];
const puts: Array<{ id: string; body: unknown }> = [];
const deletes: string[] = [];

beforeEach(() => {
  sources = [
    {
      id: "osg",
      git: "git@git.woa.com:firoyang/OSGToolset.git",
      branch: "main",
    },
  ];
  puts.length = 0;
  deletes.length = 0;
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
    http.get("/api/pack-sources", () => HttpResponse.json({ sources })),
    http.put("/api/pack-sources/:id", async ({ params, request }) => {
      const id = String(params.id);
      const body = (await request.json()) as Omit<Source, "id">;
      puts.push({ id, body });
      const created = !sources.some((s) => s.id === id);
      sources = [...sources.filter((s) => s.id !== id), { id, ...body }];
      return HttpResponse.json(
        { source: { id, ...body }, created },
        { status: created ? 201 : 200 },
      );
    }),
    http.delete("/api/pack-sources/:id", ({ params }) => {
      deletes.push(String(params.id));
      sources = sources.filter((s) => s.id !== params.id);
      return HttpResponse.json({ ok: true, removed: true });
    }),
  );
});

test("新增来源：非法 id 实时提示，合法后提交", async () => {
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  expect(
    await screen.findByText("git@git.woa.com:firoyang/OSGToolset.git"),
  ).toBeInTheDocument();
  expect(screen.getByText("修改后，在线成员重连时生效。")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /新增来源/ }));
  const dialog = await screen.findByRole("dialog");
  const id = within(dialog).getByLabelText("id");
  await user.type(id, "1bad");
  expect(
    await within(dialog).findByText("字母开头，只含字母、数字和 -"),
  ).toBeInTheDocument();
  await user.clear(id);
  await user.type(id, "osg");
  expect(
    await within(dialog).findByText("该 id 已存在，请在列表里编辑"),
  ).toBeInTheDocument();
  await user.clear(id);
  await user.type(id, "general");
  await user.type(
    within(dialog).getByLabelText("git"),
    "https://github.com/x/novoard-packs.git",
  );
  await user.type(within(dialog).getByLabelText("subdir"), "packs/general");
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    id: "general",
    body: {
      git: "https://github.com/x/novoard-packs.git",
      branch: "main",
      subdir: "packs/general",
    },
  });
});

test("编辑不需要输入 id，删除在行上确认", async () => {
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  await screen.findByText("git@git.woa.com:firoyang/OSGToolset.git");

  await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByLabelText("id")).toBeNull();
  const branch = within(dialog).getByLabelText("branch");
  await user.clear(branch);
  await user.type(branch, "release");
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]?.id).toBe("osg");
  expect(puts[0]?.body).toMatchObject({ branch: "release" });

  await user.click(screen.getByRole("button", { name: /删\s*除/ }));
  await user.click(await screen.findByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(deletes).toEqual(["osg"]));
});
