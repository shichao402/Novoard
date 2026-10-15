import {
  ApiOutlined,
  AuditOutlined,
  DashboardOutlined,
  LockOutlined,
  LogoutOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  ProForm,
  ProFormText,
  ProLayout,
} from "@ant-design/pro-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Button, Result, Skeleton, Space, Typography } from "antd";
import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ApiError, apiFetch, csrfHeaders } from "@/lib/api";
import { history } from "@/lib/navigation";
import { hasPermission, useMe, useSetupStatus } from "@/lib/queries";

const menu = [
  {
    path: "/overview",
    name: "概览",
    icon: <DashboardOutlined />,
    permission: "system.read",
  },
  {
    path: "/actions",
    name: "快捷操作",
    icon: <PlayCircleOutlined />,
    permission: "targets.execute",
  },
  {
    path: "/tasks",
    name: "任务",
    icon: <UnorderedListOutlined />,
    permission: "tasks.read",
  },
  {
    path: "/members",
    name: "成员",
    icon: <ApiOutlined />,
    permission: "targets.read",
  },
  {
    path: "/audit",
    name: "审计",
    icon: <AuditOutlined />,
    permission: "audit.read",
  },
  {
    path: "/users",
    name: "用户管理",
    icon: <TeamOutlined />,
    permission: "users.manage",
  },
  {
    path: "/roles",
    name: "角色管理",
    icon: <SafetyCertificateOutlined />,
    permission: "roles.manage",
  },
  {
    path: "/pats",
    name: "个人 PAT",
    icon: <UserOutlined />,
    permission: "pats.self.manage",
  },
  {
    path: "/wecom",
    name: "企微通道",
    icon: <SafetyCertificateOutlined />,
    permission: "wecom.manage",
  },
] as const;

export default function AppLayout() {
  const location = useLocation();
  const setup = useSetupStatus();
  const me = useMe(setup.data?.required === false);
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  useEffect(() => {
    if (setup.data?.required) history.replace("/setup");
  }, [setup.data?.required]);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401)
      history.replace("/login");
  }, [me.error]);

  const logout = useMutation({
    mutationFn: () =>
      apiFetch("/api/logout", {
        method: "POST",
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
      }),
    onSuccess: () => {
      queryClient.clear();
      history.replace("/login");
    },
    onError: (error: Error) => message.error(error.message),
  });

  if (setup.isPending || me.isPending) {
    return (
      <main className="page-content">
        <Skeleton active />
      </main>
    );
  }
  if (setup.isError)
    return (
      <Result
        status="500"
        title="无法读取初始化状态"
        subTitle={setup.error.message}
      />
    );
  if (!me.data) return null;

  if (me.data.user.forcePasswordChange) {
    return (
      <main className="public-page">
        <PageContainer title="首次登录必须修改口令">
          <ProForm
            submitter={{ searchConfig: { submitText: "修改并重新登录" } }}
            onFinish={async (values) => {
              try {
                await apiFetch("/api/me/password", {
                  method: "POST",
                  headers: csrfHeaders(me.data.csrfToken),
                  body: JSON.stringify({
                    currentPassword: values.currentPassword,
                    newPassword: values.newPassword,
                  }),
                });
                queryClient.clear();
                history.replace("/login");
                return true;
              } catch (error) {
                message.error(
                  error instanceof Error ? error.message : "修改口令失败",
                );
                return false;
              }
            }}
          >
            <ProFormText.Password
              name="currentPassword"
              label="当前口令"
              rules={[{ required: true }]}
            />
            <ProFormText.Password
              name="newPassword"
              label="新口令"
              rules={[{ required: true, min: 10, max: 256 }]}
            />
            <ProFormText.Password
              name="confirmPassword"
              label="确认新口令"
              dependencies={["newPassword"]}
              rules={[
                { required: true },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    return value === getFieldValue("newPassword")
                      ? Promise.resolve()
                      : Promise.reject(new Error("两次口令不一致"));
                  },
                }),
              ]}
            />
          </ProForm>
        </PageContainer>
      </main>
    );
  }

  const visibleMenu = menu.filter((item) =>
    hasPermission(me.data, item.permission),
  );
  const current = menu.find((item) => item.path === location.pathname);
  const forbidden = current && !hasPermission(me.data, current.permission);

  return (
    <ProLayout
      title="Novoard"
      logo={<SafetyCertificateOutlined />}
      location={{ pathname: location.pathname }}
      route={{ path: "/", routes: visibleMenu }}
      menuItemRender={(item, dom) => (
        <button
          type="button"
          onClick={() => history.push(item.path ?? "/overview")}
          style={{
            all: "unset",
            display: "block",
            width: "100%",
            cursor: "pointer",
          }}
        >
          {dom}
        </button>
      )}
      avatarProps={{
        icon: <UserOutlined />,
        title: me.data.user.displayName,
      }}
      actionsRender={() => [
        <ModalForm<{
          currentPassword: string;
          newPassword: string;
          confirmPassword: string;
        }>
          key="change-password"
          title="修改口令"
          trigger={
            <Button type="text" icon={<LockOutlined />}>
              修改口令
            </Button>
          }
          onFinish={async (values) => {
            try {
              await apiFetch("/api/me/password", {
                method: "POST",
                headers: csrfHeaders(me.data.csrfToken),
                body: JSON.stringify({
                  currentPassword: values.currentPassword,
                  newPassword: values.newPassword,
                }),
              });
              queryClient.clear();
              message.success("口令已修改，请重新登录");
              history.replace("/login");
              return true;
            } catch (error) {
              message.error(
                error instanceof Error ? error.message : "修改口令失败",
              );
              return false;
            }
          }}
        >
          <ProFormText.Password
            name="currentPassword"
            label="当前口令"
            fieldProps={{ autoComplete: "current-password" }}
            rules={[{ required: true }]}
          />
          <ProFormText.Password
            name="newPassword"
            label="新口令"
            fieldProps={{ autoComplete: "new-password" }}
            rules={[{ required: true, min: 10, max: 256 }]}
          />
          <ProFormText.Password
            name="confirmPassword"
            label="确认新口令"
            dependencies={["newPassword"]}
            fieldProps={{ autoComplete: "new-password" }}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  return value === getFieldValue("newPassword")
                    ? Promise.resolve()
                    : Promise.reject(new Error("两次口令不一致"));
                },
              }),
            ]}
          />
        </ModalForm>,
        <Button
          key="logout"
          type="text"
          icon={<LogoutOutlined />}
          loading={logout.isPending}
          onClick={() => logout.mutate()}
        >
          退出
        </Button>,
      ]}
      footerRender={() => (
        <Space>
          <Typography.Text type="secondary">
            Novoard Hub · Contract 2.0
          </Typography.Text>
        </Space>
      )}
    >
      <div className="page-content">
        {forbidden ? (
          <Result status="403" title="无权访问此页面" />
        ) : (
          <Outlet />
        )}
      </div>
    </ProLayout>
  );
}
