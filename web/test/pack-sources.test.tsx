/**
 * 能力包来源页（PRD-6 H3/H5）：
 * 1. 新增只填仓库、子目录、分支；包名默认自动，不需要输入；
 * 2. 高级里可填包名覆盖，非法时实时提示；
 * 3. 编辑、删除按行 key 操作。
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

type Source = {
  key: string;
  git: string;
  branch: string;
  subdir?: string;
  id?: string;
};
let sources: Source[] = [];
const posts: unknown[] = [];
const puts: Array<{ key: string; body: unknown }> = [];
const deletes: string[] = [];

beforeEach(() => {
  sources = [
    {
      key: "ps-aaaa0001",
      git: "git@git.woa.com:firoyang/OSGToolset.git",
      branch: "main",
    },
  ];
  posts.length = 0;
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
    http.post("/api/pack-sources", async ({ request }) => {
      const body = (await request.json()) as Omit<Source, "key">;
      posts.push(body);
      const source = { key: `ps-new${posts.length}`, ...body };
      sources = [...sources, source];
      return HttpResponse.json({ source }, { status: 201 });
    }),
    http.put("/api/pack-sources/:key", async ({ params, request }) => {
      const key = String(params.key);
      const body = (await request.json()) as Omit<Source, "key">;
      puts.push({ key, body });
      sources = sources.map((s) => (s.key === key ? { key, ...body } : s));
      return HttpResponse.json({ source: { key, ...body } });
    }),
    http.delete("/api/pack-sources/:key", ({ params }) => {
      deletes.push(String(params.key));
      sources = sources.filter((s) => s.key !== params.key);
      return HttpResponse.json({ ok: true, removed: true });
    }),
  );
});

test("新增来源：不需要填包名，列表显示「自动」", async () => {
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  expect(
    await screen.findByText("git@git.woa.com:firoyang/OSGToolset.git"),
  ).toBeInTheDocument();
  expect(screen.getByText("自动")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /新增来源/ }));
  const dialog = await screen.findByRole("dialog");
  await user.type(
    within(dialog).getByLabelText("仓库地址"),
    "https://github.com/x/novoard-packs.git",
  );
  await user.type(within(dialog).getByLabelText("子目录"), "packs/general");
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));

  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    git: "https://github.com/x/novoard-packs.git",
    branch: "main",
    subdir: "packs/general",
  });
});

test("高级里填包名覆盖：非法实时提示，合法后随来源提交", async () => {
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  await screen.findByText("git@git.woa.com:firoyang/OSGToolset.git");

  await user.click(screen.getByRole("button", { name: /新增来源/ }));
  const dialog = await screen.findByRole("dialog");
  await user.type(
    within(dialog).getByLabelText("仓库地址"),
    "https://github.com/x/novoard-packs.git",
  );
  const branch = within(dialog).getByLabelText("分支");
  await user.clear(branch);
  await user.type(branch, "dev");
  await user.click(within(dialog).getByText("高级"));
  const id = within(dialog).getByLabelText("包名覆盖");
  await user.type(id, "1bad");
  expect(
    await within(dialog).findByText("字母开头，只含字母、数字和 -"),
  ).toBeInTheDocument();
  await user.clear(id);
  await user.type(id, "vcDev");
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));

  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    git: "https://github.com/x/novoard-packs.git",
    branch: "dev",
    id: "vcDev",
  });
});

test("编辑、删除按行 key 操作", async () => {
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  await screen.findByText("git@git.woa.com:firoyang/OSGToolset.git");

  await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
  const dialog = await screen.findByRole("dialog");
  const branch = within(dialog).getByLabelText("分支");
  await user.clear(branch);
  await user.type(branch, "release");
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    key: "ps-aaaa0001",
    body: { git: "git@git.woa.com:firoyang/OSGToolset.git", branch: "release" },
  });

  await user.click(screen.getByRole("button", { name: /删\s*除/ }));
  await user.click(await screen.findByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(deletes).toEqual(["ps-aaaa0001"]));
});
