import {
  PageContainer,
  ProCard,
  StatisticCard,
} from "@ant-design/pro-components";
import { useQuery } from "@tanstack/react-query";
import { Button, Result, Space, Tag, Typography } from "antd";
import { apiFetch } from "@/lib/api";
import { history } from "@/lib/navigation";
import { queryKeys } from "@/lib/queries";

interface Status {
  version: string;
  startedAt: string | null;
  members: Array<{ agentId: string; name: string; online: boolean }>;
  tasks: { total: number; active: number };
}

export default function OverviewPage() {
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: () => apiFetch<Status>("/api/status"),
    refetchInterval: 15_000,
  });

  if (status.isError)
    return (
      <Result
        status="500"
        title="状态读取失败"
        subTitle={status.error.message}
      />
    );

  const online =
    status.data?.members.filter((member) => member.online).length ?? 0;
  return (
    <PageContainer title="概览" subTitle="Hub、成员与任务的实时状态">
      <StatisticCard.Group loading={status.isPending} direction="row">
        <StatisticCard
          statistic={{
            title: "在线成员",
            value: online,
            suffix: `/ ${status.data?.members.length ?? 0}`,
          }}
        />
        <StatisticCard
          statistic={{
            title: "活动任务",
            value: status.data?.tasks.active ?? 0,
          }}
        />
        <StatisticCard
          statistic={{
            title: "任务总数",
            value: status.data?.tasks.total ?? 0,
          }}
        />
        <StatisticCard
          statistic={{ title: "Hub 版本", value: status.data?.version ?? "-" }}
        />
      </StatisticCard.Group>
      <ProCard title="成员摘要" style={{ marginTop: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {status.data?.members.length ? (
            <Space wrap>
              {status.data.members.map((member) => (
                <Tag
                  key={member.agentId}
                  color={member.online ? "success" : "default"}
                >
                  {member.name || member.agentId} ·{" "}
                  {member.online ? "在线" : "离线"}
                </Tag>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">
              尚无 Agent 注册。请先在“成员”页签发绑定 agentId 的接入令牌。
            </Typography.Text>
          )}
          <Space>
            <Button type="primary" onClick={() => history.push("/actions")}>
              触发 Target
            </Button>
            <Button onClick={() => history.push("/tasks")}>查看任务</Button>
            <Button onClick={() => history.push("/members")}>
              管理成员接入
            </Button>
          </Space>
        </Space>
      </ProCard>
    </PageContainer>
  );
}
