import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  type ProColumns,
  ProFormDateTimePicker,
  ProFormSelect,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Modal, Popconfirm, Space, Tag, Typography } from "antd";
import { useState } from "react";
import { apiFetch, csrfHeaders, type Pat } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

const machinePermissions = new Set([
  "system.read",
  "targets.read",
  "targets.execute",
  "tasks.read",
  "tasks.cancel",
  "tasks.approve",
  "artifacts.read",
  "audit.read",
  "webhooks.invoke",
]);

export default function PatsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [issued, setIssued] = useState<{ pat: Pat; token: string } | null>(
    null,
  );
  const pats = useQuery({
    queryKey: queryKeys.pats,
    queryFn: () => apiFetch<{ pats: Pat[] }>("/api/pats"),
  });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch<{ pat: Pat; token: string }>("/api/pats", {
        method: "POST",
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
        body: JSON.stringify(body),
      }),
    onSuccess: async (result) => {
      setIssued(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.pats });
    },
    onError: (error: Error) => message.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/pats/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pats });
      message.success("PAT 已吊销");
    },
    onError: (error: Error) => message.error(error.message),
  });
  const columns: ProColumns<Pat>[] = [
    { title: "名称", dataIndex: "name" },
    { title: "所有者", dataIndex: "username" },
    {
      title: "类型",
      dataIndex: "kind",
      render: (_, row) => <Tag>{row.kind}</Tag>,
    },
    {
      title: "尾号",
      dataIndex: "tokenLastFour",
      render: (_, row) => `•••• ${row.tokenLastFour}`,
    },
    {
      title: "Scopes",
      render: (_, row) => (
        <Space wrap>
          {row.scopes.map((scope) => (
            <Tag key={scope}>{scope}</Tag>
          ))}
        </Space>
      ),
    },
    { title: "创建时间", dataIndex: "createdAt", valueType: "dateTime" },
    { title: "最近使用", dataIndex: "lastUsedAt", valueType: "dateTime" },
    {
      title: "状态",
      render: (_, row) => {
        const expired =
          !!row.expiresAt && Date.parse(row.expiresAt) <= Date.now();
        return (
          <Tag color={row.revokedAt || expired ? "error" : "success"}>
            {row.revokedAt ? "已吊销" : expired ? "已过期" : "有效"}
          </Tag>
        );
      },
    },
    {
      title: "操作",
      valueType: "option",
      render: (_, row) =>
        row.revokedAt ? null : (
          <Popconfirm
            title="确认吊销该 PAT？"
            onConfirm={() => revoke.mutate(row.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              吊销
            </Button>
          </Popconfirm>
        ),
    },
  ];
  const scopeOptions =
    me.data?.permissions
      .filter((scope) => machinePermissions.has(scope))
      .map((scope) => ({ label: scope, value: scope })) ?? [];
  const defaultScopes = scopeOptions.map((option) => option.value);
  return (
    <PageContainer
      title="个人访问令牌"
      subTitle="PAT 用于机器接口，不能登录后台；权限会随当前角色动态降权"
      extra={[
        <ModalForm
          key="create"
          title="创建 PAT"
          trigger={
            <Button
              type="primary"
              icon={<PlusOutlined />}
              aria-label="创建 PAT"
            >
              创建 PAT
            </Button>
          }
          initialValues={{
            scopes: defaultScopes,
            targetAllow: ["*"],
            targetDeny: [],
          }}
          onFinish={async (values) => {
            await create.mutateAsync(values);
            return true;
          }}
        >
          <ProFormText
            name="name"
            label="名称"
            rules={[{ required: true, max: 80 }]}
          />
          <ProFormSelect
            name="scopes"
            label="Scopes"
            mode="multiple"
            options={scopeOptions}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="targetAllow"
            label="Target Allow"
            mode="tags"
            rules={[{ required: true }]}
          />
          <ProFormSelect name="targetDeny" label="Target Deny" mode="tags" />
          <ProFormDateTimePicker name="expiresAt" label="过期时间（可选）" />
        </ModalForm>,
      ]}
    >
      <ProTable<Pat>
        rowKey="id"
        loading={pats.isPending}
        dataSource={pats.data?.pats ?? []}
        columns={columns}
        search={false}
      />
      <Modal
        open={!!issued}
        title="立即保存 PAT"
        okText="我已安全保存"
        cancelButtonProps={{ style: { display: "none" } }}
        closable={false}
        maskClosable={false}
        onOk={() => setIssued(null)}
      >
        <Typography.Paragraph type="warning">
          这是唯一一次显示明文。关闭后无法找回，只能重新签发。
        </Typography.Paragraph>
        <Typography.Paragraph copyable code>
          {issued?.token}
        </Typography.Paragraph>
      </Modal>
    </PageContainer>
  );
}
