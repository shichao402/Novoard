import { CheckOutlined, CloseOutlined, StopOutlined } from "@ant-design/icons";
import {
  PageContainer,
  type ProColumns,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Space, Tag, Typography } from "antd";
import { apiFetch, csrfHeaders, type Task } from "@/lib/api";
import { hasPermission, queryKeys, useMe } from "@/lib/queries";

const terminal = new Set(["completed", "failed", "canceled", "rejected"]);

export default function TasksPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => apiFetch<{ tasks: Task[] }>("/api/tasks"),
    refetchInterval: 5_000,
  });
  const rpc = useMutation({
    mutationFn: ({
      method,
      id,
      decision,
    }: {
      method: string;
      id: string;
      decision?: string;
    }) =>
      apiFetch("/a2a", {
        method: "POST",
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `web-${Date.now()}`,
          method,
          params: { id, ...(decision ? { decision } : {}) },
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      message.success("任务状态已更新");
    },
    onError: (error: Error) => message.error(error.message),
  });

  const columns: ProColumns<Task>[] = [
    { title: "任务", dataIndex: "id", copyable: true, width: 210 },
    { title: "Target", dataIndex: "target" },
    { title: "成员", dataIndex: "member" },
    {
      title: "状态",
      dataIndex: "state",
      render: (_, row) => (
        <Tag
          color={
            row.state === "completed"
              ? "success"
              : row.state === "failed"
                ? "error"
                : "processing"
          }
        >
          {row.state}
        </Tag>
      ),
    },
    { title: "触发者", dataIndex: "actor" },
    { title: "更新时间", dataIndex: "updatedAt", valueType: "dateTime" },
    {
      title: "操作",
      valueType: "option",
      render: (_, row) => {
        if (
          row.state === "input-required" &&
          hasPermission(me.data, "tasks.approve")
        ) {
          return (
            <Space key={row.id}>
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                onClick={() =>
                  rpc.mutate({
                    method: "tasks/approve",
                    id: row.id,
                    decision: "approve",
                  })
                }
              >
                批准
              </Button>
              <Button
                size="small"
                danger
                icon={<CloseOutlined />}
                onClick={() =>
                  rpc.mutate({
                    method: "tasks/approve",
                    id: row.id,
                    decision: "reject",
                  })
                }
              >
                拒绝
              </Button>
            </Space>
          );
        }
        if (
          !terminal.has(row.state) &&
          hasPermission(me.data, "tasks.cancel")
        ) {
          return (
            <Button
              key={row.id}
              size="small"
              danger
              icon={<StopOutlined />}
              onClick={() => rpc.mutate({ method: "tasks/cancel", id: row.id })}
            >
              取消
            </Button>
          );
        }
        return null;
      },
    },
  ];

  return (
    <PageContainer
      title="任务"
      subTitle="查看、取消和审批有权 target 范围内的任务"
    >
      <ProTable<Task>
        rowKey="id"
        loading={query.isPending}
        dataSource={query.data?.tasks ?? []}
        columns={columns}
        search={false}
        pagination={{ pageSize: 20 }}
        toolBarRender={() => [
          <Button key="refresh" onClick={() => query.refetch()}>
            刷新
          </Button>,
        ]}
        expandable={{
          expandedRowRender: (row) =>
            row.artifacts?.length ? (
              <Space direction="vertical">
                {row.artifacts.flatMap((artifact) =>
                  artifact.parts.map((part) =>
                    part.uri ? (
                      <Typography.Link
                        key={`${artifact.name}-${part.uri}`}
                        href={part.uri}
                      >
                        {artifact.name}
                      </Typography.Link>
                    ) : null,
                  ),
                )}
              </Space>
            ) : (
              <Typography.Text type="secondary">无 artifact</Typography.Text>
            ),
        }}
      />
    </PageContainer>
  );
}
