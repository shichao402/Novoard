import { EditOutlined, KeyOutlined, PlusOutlined } from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  type ProColumns,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Space, Tag } from "antd";
import { apiFetch, csrfHeaders, type Role, type User } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

export default function UsersPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const users = useQuery({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<{ users: User[] }>("/api/users"),
  });
  const roles = useQuery({
    queryKey: queryKeys.roles,
    queryFn: () => apiFetch<{ roles: Role[] }>("/api/roles"),
  });
  const mutate = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string;
      method: string;
      body: unknown;
    }) =>
      apiFetch(path, {
        method,
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.users });
      message.success("用户信息已更新");
    },
    onError: (error: Error) => message.error(error.message),
  });
  const canManageSuperadmins = me.data?.role.id === "superadmin";
  const roleOptions =
    roles.data?.roles
      .filter((role) => canManageSuperadmins || role.id !== "superadmin")
      .map((role) => ({ label: role.name, value: role.id })) ?? [];

  const columns: ProColumns<User>[] = [
    { title: "用户名", dataIndex: "username", copyable: true },
    { title: "显示名", dataIndex: "displayName" },
    {
      title: "类型",
      dataIndex: "accountType",
      render: (_, row) => (
        <Tag>{row.accountType === "service" ? "服务账号" : "登录用户"}</Tag>
      ),
    },
    {
      title: "角色",
      dataIndex: "roleId",
      render: (_, row) =>
        roles.data?.roles.find((role) => role.id === row.roleId)?.name ??
        row.roleId,
    },
    {
      title: "状态",
      dataIndex: "disabled",
      render: (_, row) => (
        <Space>
          <Tag color={row.disabled ? "error" : "success"}>
            {row.disabled ? "已禁用" : "启用"}
          </Tag>
          {row.forcePasswordChange && <Tag color="warning">待改密</Tag>}
        </Space>
      ),
    },
    {
      title: "操作",
      valueType: "option",
      render: (_, row) =>
        row.accountType === "service" ||
        (row.roleId === "superadmin" && !canManageSuperadmins)
          ? null
          : [
              <ModalForm
                key="edit"
                title={`编辑 ${row.username}`}
                trigger={
                  <Button size="small" icon={<EditOutlined />}>
                    编辑
                  </Button>
                }
                initialValues={row}
                onFinish={async (values) => {
                  await mutate.mutateAsync({
                    path: `/api/users/${encodeURIComponent(row.id)}`,
                    method: "PATCH",
                    body: {
                      displayName: values.displayName,
                      roleId: values.roleId,
                      disabled: values.disabled,
                    },
                  });
                  return true;
                }}
              >
                <ProFormText
                  name="displayName"
                  label="显示名"
                  rules={[{ required: true, max: 80 }]}
                />
                <ProFormSelect
                  name="roleId"
                  label="角色"
                  options={roleOptions}
                  rules={[{ required: true }]}
                />
                <ProFormSwitch name="disabled" label="禁用账号" />
              </ModalForm>,
              row.roleId !== "superadmin" && (
                <ModalForm
                  key="password"
                  title={`重置 ${row.username} 的口令`}
                  trigger={
                    <Button size="small" icon={<KeyOutlined />}>
                      重置口令
                    </Button>
                  }
                  onFinish={async ({ password }) => {
                    await mutate.mutateAsync({
                      path: `/api/users/${encodeURIComponent(row.id)}/reset-password`,
                      method: "POST",
                      body: { password },
                    });
                    return true;
                  }}
                >
                  <ProFormText.Password
                    name="password"
                    label="临时口令"
                    rules={[{ required: true, min: 10, max: 256 }]}
                  />
                </ModalForm>
              ),
            ],
    },
  ];

  return (
    <PageContainer
      title="用户管理"
      subTitle="账号只绑定一个角色；禁用、改密或换角色会立即使旧凭据失效"
      extra={[
        <ModalForm
          key="create"
          title="创建用户"
          trigger={
            <Button
              type="primary"
              icon={<PlusOutlined />}
              aria-label="创建用户"
            >
              创建用户
            </Button>
          }
          initialValues={{ roleId: "viewer", forcePasswordChange: true }}
          onFinish={async (values) => {
            await mutate.mutateAsync({
              path: "/api/users",
              method: "POST",
              body: values,
            });
            return true;
          }}
        >
          <ProFormText
            name="username"
            label="用户名"
            rules={[
              { required: true },
              { pattern: /^[a-z0-9][a-z0-9._-]{2,31}$/, message: "格式不正确" },
            ]}
          />
          <ProFormText
            name="displayName"
            label="显示名"
            rules={[{ max: 80 }]}
          />
          <ProFormText.Password
            name="password"
            label="临时口令"
            rules={[{ required: true, min: 10, max: 256 }]}
          />
          <ProFormSelect
            name="roleId"
            label="角色"
            options={roleOptions}
            rules={[{ required: true }]}
          />
          <ProFormSwitch name="forcePasswordChange" label="首次登录强制改密" />
        </ModalForm>,
      ]}
    >
      <ProTable<User>
        rowKey="id"
        loading={users.isPending || roles.isPending}
        dataSource={users.data?.users ?? []}
        columns={columns}
        search={false}
      />
    </PageContainer>
  );
}
