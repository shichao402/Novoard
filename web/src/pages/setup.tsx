import { ProForm, ProFormText } from "@ant-design/pro-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Result, Skeleton } from "antd";
import { useEffect } from "react";
import { PublicCard } from "@/components/PublicCard";
import { apiFetch } from "@/lib/api";
import { history } from "@/lib/navigation";
import { queryKeys, useSetupStatus } from "@/lib/queries";

interface SetupValues {
  username: string;
  displayName: string;
  password: string;
  confirmPassword: string;
}

export default function SetupPage() {
  const setup = useSetupStatus();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  useEffect(() => {
    if (setup.data?.required === false) history.replace("/overview");
  }, [setup.data?.required]);

  const mutation = useMutation({
    mutationFn: (values: SetupValues) =>
      apiFetch("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          username: values.username,
          displayName: values.displayName,
          password: values.password,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      history.replace("/overview");
    },
    onError: (error: Error) => message.error(error.message),
  });

  if (setup.isPending) return <Skeleton active />;
  if (setup.isError)
    return (
      <Result
        status="500"
        title="无法连接 Hub"
        subTitle={setup.error.message}
      />
    );
  if (!setup.data?.required) return null;

  return (
    <PublicCard
      title="初始化 Novoard"
      subtitle="创建本实例唯一的首位超级管理员"
    >
      <Alert
        type="warning"
        showIcon
        message="公开 first-claim 初始化"
        description="第一个成功提交的人将成为超级管理员。请确认你正在管理自己的服务器，并立即完成初始化。"
      />
      <ProForm<SetupValues>
        submitter={{
          submitButtonProps: { block: true, loading: mutation.isPending },
          searchConfig: { submitText: "创建超级管理员" },
        }}
        onFinish={async (values) => {
          await mutation.mutateAsync(values);
          return true;
        }}
      >
        <ProFormText
          name="username"
          label="用户名"
          fieldProps={{ autoComplete: "username" }}
          rules={[
            { required: true },
            {
              pattern: /^[a-z0-9][a-z0-9._-]{2,31}$/,
              message: "使用 3-32 位小写字母、数字、点、下划线或连字符",
            },
          ]}
        />
        <ProFormText name="displayName" label="显示名" rules={[{ max: 80 }]} />
        <ProFormText.Password
          name="password"
          label="口令"
          fieldProps={{ autoComplete: "new-password" }}
          rules={[{ required: true, min: 12, max: 256 }]}
        />
        <ProFormText.Password
          name="confirmPassword"
          label="确认口令"
          dependencies={["password"]}
          fieldProps={{ autoComplete: "new-password" }}
          rules={[
            { required: true },
            ({ getFieldValue }) => ({
              validator(_, value) {
                return value === getFieldValue("password")
                  ? Promise.resolve()
                  : Promise.reject(new Error("两次口令不一致"));
              },
            }),
          ]}
        />
      </ProForm>
    </PublicCard>
  );
}
