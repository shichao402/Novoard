/**
 * 能力包来源页（PRD-6 H3/H5/H6，契约 v2.7）：
 * 1. 新增只填仓库和分支，不再有子目录和包名；
 * 2. 旧的包名覆盖条目显示标签，编辑时保留 id / subdir；
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
  permissions: [
    "system.read",
    "targets.read",
    "users.manage",
    "pack-sources.read",
    "pack-sources.manage",
  ],
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
let permissions = role.permissions;
const posts: unknown[] = [];
const puts: Array<{ key: string; body: unknown }> = [];
const deletes: string[] = [];

beforeEach(() => {
  permissions = role.permissions;
  sources = [
    {
      key: "ps-aaaa0001",
      git: "git@git.example.com:team/my-packs.git",
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
        permissions,
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

test("新增来源：只填仓库和分支", async () => {
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  expect(
    await screen.findByText("git@git.example.com:team/my-packs.git"),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /新增来源/ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByLabelText("子目录")).toBeNull();
  expect(within(dialog).queryByLabelText("包名覆盖")).toBeNull();
  await user.type(
    within(dialog).getByLabelText("仓库地址"),
    "https://github.com/x/novoard-packs.git",
  );
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));

  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    git: "https://github.com/x/novoard-packs.git",
    branch: "main",
  });
});

test("旧的包名覆盖条目：显示标签，编辑时保留 id 与 subdir", async () => {
  sources = [
    {
      key: "ps-bbbb0002",
      git: "https://github.com/x/novoard-packs.git",
      branch: "dev",
      subdir: "packs/versionControl",
      id: "vcDev",
    },
  ];
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  expect(
    await screen.findByText(/包名覆盖 vcDev \/ packs\/versionControl/),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
  const dialog = await screen.findByRole("dialog");
  const branch = within(dialog).getByLabelText("分支");
  await user.clear(branch);
  await user.type(branch, "next");
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    key: "ps-bbbb0002",
    body: {
      git: "https://github.com/x/novoard-packs.git",
      branch: "next",
      id: "vcDev",
      subdir: "packs/versionControl",
    },
  });
});

test("编辑、删除按行 key 操作", async () => {
  const user = userEvent.setup();
  renderApp(<PackSourcesPage />);
  await screen.findByText("git@git.example.com:team/my-packs.git");

  await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
  const dialog = await screen.findByRole("dialog");
  const branch = within(dialog).getByLabelText("分支");
  await user.clear(branch);
  await user.type(branch, "release");
  await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    key: "ps-aaaa0001",
    body: { git: "git@git.example.com:team/my-packs.git", branch: "release" },
  });

  await user.click(screen.getByRole("button", { name: /删\s*除/ }));
  await user.click(await screen.findByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(deletes).toEqual(["ps-aaaa0001"]));
});

test("来源只读权限显示清单，不显示新增/编辑/删除操作", async () => {
  permissions = ["pack-sources.read"];
  renderApp(<PackSourcesPage />);
  await screen.findByText("git@git.example.com:team/my-packs.git");
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /新增来源/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /编\s*辑/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /删\s*除/ })).toBeNull();
  });
  expect(posts).toHaveLength(0);
  expect(puts).toHaveLength(0);
  expect(deletes).toHaveLength(0);
});
