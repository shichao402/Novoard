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
import { apiFetch, csrfHeaders, type TargetMember } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

export default function MembersPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [issued, setIssued] = useState<{
    agentId: string;
    token: string;
  } | null>(null);
  const targets = useQuery({
    queryKey: queryKeys.targets,
    queryFn: () => apiFetch<{ catalog: TargetMember[] }>("/api/targets"),
    refetchInterval: 10_000,
  });
  const credentials = useQuery({
    queryKey: queryKeys.agentCredentials,
    queryFn: () => apiFetch<{ agentIds: string[] }>("/api/agent-credentials"),
    enabled: me.data?.role.id === "superadmin",
  });
  const issue = useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<{ agentId: string; token: string }>(
        `/api/agent-credentials/${encodeURIComponent(agentId)}`,
        {
          method: "POST",
          headers: csrfHeaders(me.data?.csrfToken ?? ""),
        },
      ),
    onSuccess: async (result) => {
      setIssued(result);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agentCredentials,
      });
    },
    onError: (error: Error) => message.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (agentId: string) =>
      apiFetch(`/api/agent-credentials/${encodeURIComponent(agentId)}`, {
        method: "DELETE",
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agentCredentials,
      });
      message.success("Agent 令牌已吊销");
    },
    onError: (error: Error) => message.error(error.message),
  });

  const columns: ProColumns<TargetMember>[] = [
    { title: "agentId", dataIndex: "agentId", copyable: true },
    { title: "名称", dataIndex: "name" },
    {
      title: "状态",
      dataIndex: "online",
      render: (_, row) => (
        <Tag color={row.online ? "success" : "default"}>
          {row.online ? "在线" : "离线"}
        </Tag>
      ),
    },
    { title: "Target 数", render: (_, row) => row.skills.length },
    {
      title: "接入凭据",
      hideInTable: me.data?.role.id !== "superadmin",
      render: (_, row) => {
        const configured = credentials.data?.agentIds.includes(row.agentId);
        return (
          <Space>
            <Tag color={configured ? "success" : "warning"}>
              {configured ? "已签发" : "未签发"}
            </Tag>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => issue.mutate(row.agentId)}
            >
              {configured ? "轮换" : "签发"}
            </Button>
            {configured && (
              <Popconfirm
                title="吊销后 Agent 下次连接将失败，确认继续？"
                onConfirm={() => revoke.mutate(row.agentId)}
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
      subTitle="Agent 接入令牌绑定 agentId；明文只在签发时展示一次"
      extra={
        me.data?.role.id === "superadmin"
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
      <ProTable<TargetMember>
        rowKey="agentId"
        loading={targets.isPending}
        dataSource={targets.data?.catalog ?? []}
        columns={columns}
        search={false}
        expandable={{
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
        title={`保存 ${issued?.agentId ?? ""} 的 Agent 令牌`}
        okText="我已安全保存"
        cancelButtonProps={{ style: { display: "none" } }}
        closable={false}
        maskClosable={false}
        onOk={() => setIssued(null)}
      >
        <Typography.Paragraph type="warning">
          该明文不会再次显示。请写入对应 Agent 的本机私密配置。
        </Typography.Paragraph>
        <Typography.Paragraph copyable code>
          {issued?.token}
        </Typography.Paragraph>
      </Modal>
    </PageContainer>
  );
}
