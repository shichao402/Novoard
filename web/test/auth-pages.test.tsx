import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, test } from "vitest";
import LoginPage from "@/pages/login";
import SetupPage from "@/pages/setup";
import { renderApp } from "./render";
import { server } from "./server";
import { historyMock } from "./setup";

beforeEach(() => {
  historyMock.push.mockReset();
  historyMock.replace.mockReset();
});

describe("初始化与登录", () => {
  test("零用户时显示初始化表单并提交首位超级管理员", async () => {
    let submitted: any = null;
    server.use(
      http.get("/api/setup/status", () =>
        HttpResponse.json({ required: true }),
      ),
      http.post("/api/setup", async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json(
          { user: { username: "owner" }, csrfToken: "csrf" },
          { status: 201 },
        );
      }),
    );
    renderApp(<SetupPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("用户名"), "owner");
    await user.type(screen.getByLabelText("显示名"), "Owner");
    await user.type(screen.getByLabelText("口令"), "correct horse battery");
    await user.type(screen.getByLabelText("确认口令"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "创建超级管理员" }));
    await waitFor(() =>
      expect(historyMock.replace).toHaveBeenCalledWith("/overview"),
    );
    expect(submitted).toEqual({
      username: "owner",
      displayName: "Owner",
      password: "correct horse battery",
    });
  });

  test("初始化入口关闭后交给受保护概览处理会话", async () => {
    server.use(
      http.get("/api/setup/status", () =>
        HttpResponse.json({ required: false }),
      ),
    );
    renderApp(<SetupPage />);
    await waitFor(() =>
      expect(historyMock.replace).toHaveBeenCalledWith("/overview"),
    );
    expect(historyMock.replace).not.toHaveBeenCalledWith("/login");
  });

  test("初始化完成后登录并进入概览", async () => {
    server.use(
      http.get("/api/setup/status", () =>
        HttpResponse.json({ required: false }),
      ),
      http.post("/api/session", () =>
        HttpResponse.json({ user: { username: "owner" }, csrfToken: "csrf" }),
      ),
    );
    renderApp(<LoginPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("用户名"), "owner");
    await user.type(
      screen.getByPlaceholderText("口令"),
      "correct horse battery",
    );
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(historyMock.replace).toHaveBeenCalledWith("/overview"),
    );
  });
});
