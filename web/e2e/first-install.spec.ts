import { expect, request, test } from "@playwright/test";

const origin = "http://127.0.0.1:38667";

test("全新安装 → 超级管理员 → 角色/用户 → 用户 PAT → 受限 API", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("初始化 Novoard")).toBeVisible();
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("显示名").fill("Owner");
  await page.getByLabel("口令", { exact: true }).fill("owner password 12345");
  await page.getByLabel("确认口令").fill("owner password 12345");
  await page.getByRole("button", { name: "创建超级管理员" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(
    page.getByTestId("pro-page-header").getByText("概览", { exact: true }),
  ).toBeVisible();

  const ownerMe = await (await page.request.get("/api/me")).json();
  const ownerHeaders = {
    Origin: origin,
    "X-CSRF-Token": ownerMe.csrfToken,
    "Content-Type": "application/json",
  };
  let response = await page.request.post("/api/roles", {
    headers: ownerHeaders,
    data: {
      id: "api-reader",
      name: "API Reader",
      permissions: ["system.read", "pats.self.manage"],
      targetAllow: ["mac-work/*"],
      targetDeny: [],
    },
  });
  expect(response.status()).toBe(201);

  response = await page.request.post("/api/users", {
    headers: ownerHeaders,
    data: {
      username: "reader",
      displayName: "Reader",
      password: "reader password 12345",
      roleId: "api-reader",
      forcePasswordChange: false,
    },
  });
  expect(response.status()).toBe(201);

  response = await page.request.post("/api/logout", { headers: ownerHeaders });
  expect(response.ok()).toBeTruthy();
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill("reader");
  await page.getByPlaceholder("口令").fill("reader password 12345");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(
    page.getByTestId("pro-page-header").getByText("概览", { exact: true }),
  ).toBeVisible();

  const readerMe = await (await page.request.get("/api/me")).json();
  response = await page.request.post("/api/pats", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": readerMe.csrfToken,
      "Content-Type": "application/json",
    },
    data: {
      name: "e2e-reader",
      scopes: ["system.read"],
      targetAllow: ["mac-work/*"],
      targetDeny: [],
    },
  });
  expect(response.status()).toBe(201);
  const { token } = await response.json();
  expect(token).toMatch(/^nvp_/);

  const patClient = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  expect((await patClient.get("/api/status")).status()).toBe(200);
  expect((await patClient.get("/api/users")).status()).toBe(401);
  expect(
    (
      await patClient.post("/api/trigger", { data: { target: "forbidden" } })
    ).status(),
  ).toBe(403);
  await patClient.dispose();
});
