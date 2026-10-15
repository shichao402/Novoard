import {
  PageContainer,
  ProCard,
  ProForm,
  ProFormSelect,
  ProFormTextArea,
} from "@ant-design/pro-components";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, App, Result, Tag } from "antd";
import { apiFetch, csrfHeaders, type TargetMember } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

interface ActionValues {
  selection: string;
  vars?: string;
}

export default function ActionsPage() {
  const { message } = App.useApp();
  const me = useMe();
  const targets = useQuery({
    queryKey: queryKeys.targets,
    queryFn: () => apiFetch<{ catalog: TargetMember[] }>("/api/targets"),
  });
  const trigger = useMutation({
    mutationFn: ({
      target,
      member,
      vars,
    }: {
      target: string;
      member: string;
      vars: Record<string, unknown>;
    }) =>
      apiFetch<{ taskId?: string; state: string; reason?: string }>(
        "/api/trigger",
        {
          method: "POST",
          headers: csrfHeaders(me.data?.csrfToken ?? ""),
          body: JSON.stringify({ target, member, vars }),
        },
      ),
    onSuccess: (result) =>
      message.success(
        result.taskId
          ? `任务已受理：${result.taskId}`
          : `请求结果：${result.state}`,
      ),
    onError: (error: Error) => message.error(error.message),
  });

  if (targets.isError)
    return (
      <Result
        status="500"
        title="Target 目录读取失败"
        subTitle={targets.error.message}
      />
    );
  const options =
    targets.data?.catalog.flatMap((member) =>
      member.skills.map((skill) => ({
        label: (
          <span>
            {skill.name || skill.id} · {member.name || member.agentId}{" "}
            <Tag color={member.online ? "success" : "default"}>
              {member.online ? "在线" : "离线"}
            </Tag>
          </span>
        ),
        value: `${member.agentId}/${skill.id}`,
      })),
    ) ?? [];

  return (
    <PageContainer
      title="快捷操作"
      subTitle="所有触发仍由服务端执行权限与 target 范围裁决"
    >
      <ProCard>
        {!options.length && (
          <Alert
            type="info"
            showIcon
            message="当前没有你有权查看和触发的 Target"
          />
        )}
        <ProForm<ActionValues>
          submitter={{
            submitButtonProps: {
              loading: trigger.isPending,
              disabled: !options.length,
            },
            searchConfig: { submitText: "触发" },
          }}
          onFinish={async ({ selection, vars }) => {
            const [member = "", target = ""] = selection.split("/");
            let parsedVars = {};
            if (vars?.trim()) {
              try {
                parsedVars = JSON.parse(vars);
              } catch {
                message.error("变量必须是合法 JSON 对象");
                return false;
              }
            }
            await trigger.mutateAsync({ target, member, vars: parsedVars });
            return true;
          }}
        >
          <ProFormSelect
            name="selection"
            label="Target"
            options={options}
            rules={[{ required: true }]}
          />
          <ProFormTextArea
            name="vars"
            label="运行变量（可选）"
            placeholder='{"branch":"main"}'
            fieldProps={{ autoSize: { minRows: 3, maxRows: 8 } }}
          />
        </ProForm>
      </ProCard>
    </PageContainer>
  );
}
