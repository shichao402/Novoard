import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import {
  PageContainer,
  ProCard,
  ProForm,
  ProFormSelect,
  ProFormText,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Descriptions, Popconfirm, Space, Tag } from "antd";
import { apiFetch, csrfHeaders, type WecomConfig } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

export default function WecomPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const config = useQuery({
    queryKey: queryKeys.wecom,
    queryFn: () => apiFetch<{ config: WecomConfig }>("/api/wecom/config"),
  });
  const save = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch("/api/wecom/config", {
        method: "PATCH",
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.wecom });
      message.success("企微配置已保存");
    },
    onError: (error: Error) => message.error(error.message),
  });
  const rotate = useMutation({
    mutationFn: () =>
      apiFetch("/api/wecom/service-pat/rotate", {
        method: "POST",
        headers: csrfHeaders(me.data?.csrfToken ?? ""),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.wecom });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pats });
      message.success("服务 PAT 已验证、切换，旧 PAT 已吊销");
    },
    onError: (error: Error) => message.error(error.message),
  });
  const current = config.data?.config;

  return (
    <PageContainer
      title="企微通道"
      subTitle="默认拒绝所有指令；单聊校验用户，群聊同时校验用户和会话"
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type={current?.allowedUserIds.length ? "info" : "warning"}
          showIcon
          message={
            current?.allowedUserIds.length
              ? "白名单已配置"
              : "用户白名单为空，所有 run/approve/reject 都会被拒绝"
          }
        />
        <ProCard title="通道状态">
          <Descriptions column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label="Bot Secret">
              <Tag color={current?.botSecretConfigured ? "success" : "warning"}>
                {current?.botSecretConfigured ? "已配置" : "未配置"}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="服务 PAT">
              <Tag
                color={current?.servicePatConfigured ? "success" : "warning"}
              >
                {current?.servicePatConfigured ? "已配置" : "未配置"}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="服务账号">
              {current?.serviceAccount?.username ?? "尚未创建"}
            </Descriptions.Item>
            <Descriptions.Item label="通知目标">
              {current?.notifyChatId || "未配置"}
            </Descriptions.Item>
          </Descriptions>
        </ProCard>
        {current && (
          <ProCard title="白名单与凭据">
            <ProForm
              key={`${current.servicePatId}-${current.botId}`}
              initialValues={{
                botId: current.botId,
                allowedUserIds: current.allowedUserIds,
                allowedChatIds: current.allowedChatIds,
                notifyChatId: current.notifyChatId,
              }}
              submitter={{
                render: (_, dom) => [
                  ...dom,
                  <Popconfirm
                    key="rotate"
                    title="新 PAT 验证并切换后会立即吊销旧 PAT，确认继续？"
                    onConfirm={() => rotate.mutate()}
                  >
                    <Button
                      icon={<ReloadOutlined />}
                      loading={rotate.isPending}
                    >
                      轮换服务 PAT
                    </Button>
                  </Popconfirm>,
                ],
                submitButtonProps: {
                  icon: <SaveOutlined />,
                  loading: save.isPending,
                },
              }}
              onFinish={async (values) => {
                const body = { ...values };
                if (!body.botSecret) delete body.botSecret;
                await save.mutateAsync(body);
                return true;
              }}
            >
              <ProFormText name="botId" label="Bot ID" />
              <ProFormText.Password
                name="botSecret"
                label="Bot Secret"
                placeholder="留空表示不修改"
              />
              <ProFormSelect
                name="allowedUserIds"
                label="允许的用户 ID"
                mode="tags"
              />
              <ProFormSelect
                name="allowedChatIds"
                label="允许的群聊 ID"
                mode="tags"
              />
              <ProFormText name="notifyChatId" label="固定通知目标" />
            </ProForm>
          </ProCard>
        )}
      </Space>
    </PageContainer>
  );
}
