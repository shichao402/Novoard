import {
  PageContainer,
  type ProColumns,
  ProTable,
} from "@ant-design/pro-components";
import { useQuery } from "@tanstack/react-query";
import { Button, Tag, Typography } from "antd";
import { type AuditEvent, apiFetch } from "@/lib/api";
import { queryKeys } from "@/lib/queries";

export default function AuditPage() {
  const query = useQuery({
    queryKey: queryKeys.events,
    queryFn: () => apiFetch<{ events: AuditEvent[] }>("/api/events"),
    refetchInterval: 10_000,
  });
  const columns: ProColumns<AuditEvent>[] = [
    { title: "时间", dataIndex: "ts", valueType: "dateTime", width: 180 },
    { title: "Actor", dataIndex: "actor", copyable: true },
    { title: "车道", dataIndex: "lane", width: 80 },
    { title: "Target", dataIndex: "target" },
    { title: "Task", dataIndex: "taskId", copyable: true },
    {
      title: "结果",
      dataIndex: "outcome",
      render: (_, row) => (
        <Tag
          color={
            row.outcome === "rejected" || row.outcome === "failed"
              ? "error"
              : "default"
          }
        >
          {row.outcome}
        </Tag>
      ),
    },
  ];
  return (
    <PageContainer title="审计" subTitle="身份、安全与任务操作的追加式流水">
      <ProTable<AuditEvent>
        rowKey={(row) => `${row.ts}-${row.actor}-${row.taskId ?? row.target}`}
        loading={query.isPending}
        dataSource={query.data?.events ?? []}
        columns={columns}
        search={{ labelWidth: "auto" }}
        pagination={{ pageSize: 25 }}
        toolBarRender={() => [
          <Button key="refresh" onClick={() => query.refetch()}>
            刷新
          </Button>,
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Typography.Paragraph>
              <pre>{JSON.stringify(row.detail ?? {}, null, 2)}</pre>
            </Typography.Paragraph>
          ),
        }}
      />
    </PageContainer>
  );
}
