import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  type ProColumns,
  ProFormCheckbox,
  ProFormSelect,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Popconfirm, Space, Tag } from "antd";
import { apiFetch, csrfHeaders, type Role } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

const operationalPermissions = [
  "system.read",
  "targets.read",
  "targets.execute",
  "tasks.read",
  "tasks.cancel",
  "tasks.approve",
  "artifacts.read",
  "audit.read",
  "pats.self.manage",
  "webhooks.invoke",
].map((value) => ({ label: value, value }));

function RoleFields() {
  return (
    <>
      <ProFormText
        name="name"
        label="角色名称"
        rules={[{ required: true, max: 80 }]}
      />
      <ProFormCheckbox.Group
        name="permissions"
        label="业务权限"
        options={operationalPermissions}
      />
      <ProFormSelect
        name="targetAllow"
        label="允许的 Target 范围"
        mode="tags"
        placeholder="如 mac-work/*；自定义角色默认拒绝"
        rules={[{ required: true, message: "至少配置一个 allow 范围" }]}
      />
      <ProFormSelect
        name="targetDeny"
        label="拒绝的 Target 范围"
        mode="tags"
        placeholder="deny 优先，可留空"
      />
    </>
  );
}

export default function RolesPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
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
      body?: unknown;
    }) =>
      apiFetch(path, {
        method,
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roles });
      message.success("角色已更新");
    },
    onError: (error: Error) => message.error(error.message),
  });
  const columns: ProColumns<Role>[] = [
    { title: "角色 ID", dataIndex: "id", copyable: true },
    { title: "名称", dataIndex: "name" },
    {
      title: "类型",
      render: (_, row) => (
        <Tag color={row.builtIn ? "blue" : "default"}>
          {row.builtIn ? "内置" : "自定义"}
        </Tag>
      ),
    },
    { title: "权限数", render: (_, row) => row.permissions.length },
    {
      title: "Allow",
      render: (_, row) => (
        <Space wrap>
          {row.targetAllow.map((item) => (
            <Tag key={item}>{item}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "Deny",
      render: (_, row) => (
        <Space wrap>
          {row.targetDeny.map((item) => (
            <Tag color="error" key={item}>
              {item}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "操作",
      valueType: "option",
      render: (_, row) =>
        row.builtIn
          ? null
          : [
              <ModalForm
                key="edit"
                title={`编辑 ${row.name}`}
                trigger={
                  <Button size="small" icon={<EditOutlined />}>
                    编辑
                  </Button>
                }
                initialValues={row}
                onFinish={async (values) => {
                  await mutate.mutateAsync({
                    path: `/api/roles/${encodeURIComponent(row.id)}`,
                    method: "PATCH",
                    body: values,
                  });
                  return true;
                }}
              >
                <RoleFields />
              </ModalForm>,
              <Popconfirm
                key="delete"
                title="仅未被用户引用的角色可删除，确认继续？"
                onConfirm={() =>
                  mutate.mutate({
                    path: `/api/roles/${encodeURIComponent(row.id)}`,
                    method: "DELETE",
                  })
                }
              >
                <Button size="small" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>,
            ],
    },
  ];
  return (
    <PageContainer
      title="角色管理"
      subTitle="内置角色不可编辑；自定义角色只能组合业务权限，并须显式配置 Target 范围"
      extra={[
        <ModalForm
          key="create"
          title="创建自定义角色"
          trigger={
            <Button
              type="primary"
              icon={<PlusOutlined />}
              aria-label="创建角色"
            >
              创建角色
            </Button>
          }
          initialValues={{
            permissions: ["system.read"],
            targetAllow: [],
            targetDeny: [],
          }}
          onFinish={async (values) => {
            await mutate.mutateAsync({
              path: "/api/roles",
              method: "POST",
              body: values,
            });
            return true;
          }}
        >
          <ProFormText
            name="id"
            label="角色 ID"
            rules={[
              { required: true },
              {
                pattern: /^[a-z][a-z0-9-]{2,31}$/,
                message: "使用 3-32 位小写字母、数字或连字符",
              },
            ]}
          />
          <RoleFields />
        </ModalForm>,
      ]}
    >
      <ProTable<Role>
        rowKey="id"
        loading={roles.isPending}
        dataSource={roles.data?.roles ?? []}
        columns={columns}
        search={false}
      />
    </PageContainer>
  );
}
