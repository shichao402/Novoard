import { KeyOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  type ProColumns,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Modal, Popconfirm, Space, Tag, Typography } from "antd";
import { useState } from "react";
import { apiFetch, csrfHeaders, type MemberView } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

/**
 * 成员页数据只有一个来源：GET /api/members。
 * 该端点由服务端把 members.json（身份 SSOT）与注册表在场层合成，
 * 因此"已签发但从未接入"的成员与在线成员出现在同一张表里，都能轮换和吊销。
 */
export default function MembersPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [issued, setIssued] = useState<{
    agentId: string;
    token: string;
    rotated: boolean;
  } | null>(null);
  const canManageCredentials = me.data?.role.id === "superadmin";

  const members = useQuery({
    queryKey: queryKeys.members,
    queryFn: () => apiFetch<{ members: MemberView[] }>("/api/members"),
    refetchInterval: 10_000,
  });

  async function refreshMembers() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.members });
    await queryClient.invalidateQueries({ queryKey: queryKeys.status });
  }

  const issue = useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<{ agentId: string; token: string; rotated: boolean }>(
        `/api/members/${encodeURIComponent(agentId)}`,
        {
          method: "POST",
          headers: csrfHeaders(me.data?.csrfToken ?? ""),
        },
      ),
    onSuccess: async (result) => {
      setIssued(result);
      await refreshMembers();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<{ ok: boolean; agentId: string; removed: boolean }>(
        `/api/members/${encodeURIComponent(agentId)}`,
        {
          method: "DELETE",
          headers: csrfHeaders(me.data?.csrfToken ?? ""),
        },
      ),
    onSuccess: async (result) => {
      await refreshMembers();
      message.success(
        result.removed
          ? "成员凭据已移除，该 agentId 下次连接将失败"
          : "该成员没有可移除的凭据",
      );
    },
    onError: (error: Error) => message.error(error.message),
  });

  const columns: ProColumns<MemberView>[] = [
    { title: "agentId", dataIndex: "agentId", copyable: true },
    { title: "名称", dataIndex: "name" },
    {
      title: "接入状态",
      dataIndex: "online",
      render: (_, row) => {
        if (row.online) return <Tag color="success">在线</Tag>;
        if (!row.registered) {
          return (
            <Tag
              color="default"
              title="凭据已签发，但该 agent 从未用此 agentId 接入过"
            >
              未接入
            </Tag>
          );
        }
        return <Tag color="warning">离线</Tag>;
      },
    },
    {
      title: "Target 数",
      dataIndex: "skillCount",
      render: (_, row) => (row.registered ? row.skillCount : "—"),
    },
    {
      title: "接入凭据",
      hideInTable: !canManageCredentials,
      render: (_, row) => {
        const credentials = row.credentials;
        const configured = !!credentials?.configured;
        return (
          <Space wrap>
            <Tag color={configured ? "success" : "warning"}>
              {configured ? "已签发" : "未签发"}
            </Tag>
            {configured && credentials?.lastFour && (
              <Typography.Text type="secondary" code>
                …{credentials.lastFour}
              </Typography.Text>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => issue.mutate(row.agentId)}
            >
              {configured ? "轮换" : "签发"}
            </Button>
            {configured && (
              <Popconfirm
                title="移除后该成员凭据立即失效，Agent 下次连接将失败。确认继续？"
                onConfirm={() => remove.mutate(row.agentId)}
              >
                <Button size="small" danger>
                  吊销
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <PageContainer
      title="成员"
      subTitle="成员身份与接入令牌持久化在 hub；明文只在签发时展示一次"
      extra={
        canManageCredentials
          ? [
              <ModalForm<{ agentId: string }>
                key="issue"
                title="签发 Agent 令牌"
                trigger={
                  <Button type="primary" icon={<KeyOutlined />}>
                    签发新成员令牌
                  </Button>
                }
                onFinish={async ({ agentId }) => {
                  await issue.mutateAsync(agentId);
                  return true;
                }}
              >
                <ProFormText
                  name="agentId"
                  label="agentId"
                  rules={[
                    { required: true },
                    {
                      pattern: /^[a-z0-9][a-z0-9-]{1,63}$/,
                      message: "使用 2-64 位小写字母、数字或连字符",
                    },
                  ]}
                />
              </ModalForm>,
            ]
          : undefined
      }
    >
      <ProTable<MemberView>
        rowKey="agentId"
        loading={members.isPending}
        dataSource={members.data?.members ?? []}
        columns={columns}
        search={false}
        expandable={{
          rowExpandable: (row) => row.registered && row.skills.length > 0,
          expandedRowRender: (row) => (
            <Space wrap>
              {row.skills.map((skill) => (
                <Tag key={skill.id}>{skill.name || skill.id}</Tag>
              ))}
            </Space>
          ),
        }}
      />
      <Modal
        open={!!issued}
        title={`${issued?.rotated ? "已轮换" : "已签发"} ${issued?.agentId ?? ""} 的 Agent 令牌`}
        okText="我已安全保存"
        cancelButtonProps={{ style: { display: "none" } }}
        closable={false}
        maskClosable={false}
        onOk={() => setIssued(null)}
      >
        <Typography.Paragraph type="warning">
          该明文不会再次显示。请写入对应 Agent 的本机私密配置
          {issued?.rotated ? "；旧令牌已立即失效。" : "。"}
        </Typography.Paragraph>
        <Typography.Paragraph copyable code>
          {issued?.token}
        </Typography.Paragraph>
      </Modal>
    </PageContainer>
  );
}
