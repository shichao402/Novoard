import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { LoginFormPage, ProFormText } from "@ant-design/pro-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Skeleton } from "antd";
import { useEffect } from "react";
import { ApiError, apiFetch } from "@/lib/api";
import { history } from "@/lib/navigation";
import { queryKeys, useSetupStatus } from "@/lib/queries";

interface LoginValues {
  username: string;
  password: string;
}

export default function LoginPage() {
  const setup = useSetupStatus();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  useEffect(() => {
    if (setup.data?.required) history.replace("/setup");
  }, [setup.data?.required]);

  const mutation = useMutation({
    mutationFn: (values: LoginValues) =>
      apiFetch("/api/session", {
        method: "POST",
        body: JSON.stringify(values),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      history.replace("/overview");
    },
    onError: (error) =>
      message.error(
        error instanceof ApiError && error.status === 429
          ? "尝试次数过多，请稍后重试"
          : "用户名或口令错误",
      ),
  });

  if (setup.isPending) return <Skeleton active />;
  if (setup.data?.required) return null;

  return (
    <main className="public-page">
      <LoginFormPage<LoginValues>
        title="Novoard"
        subTitle="Hub 管理控制台"
        submitter={{
          submitButtonProps: {
            "aria-label": "登录",
            loading: mutation.isPending,
          },
          searchConfig: { submitText: "登录" },
        }}
        onFinish={async (values) => {
          await mutation.mutateAsync(values);
          return true;
        }}
      >
        <Alert
          type="info"
          showIcon
          title="使用管理员分配的账号登录"
          style={{ marginBottom: 24 }}
        />
        <ProFormText
          name="username"
          fieldProps={{
            size: "large",
            prefix: <UserOutlined />,
            autoComplete: "username",
          }}
          placeholder="用户名"
          rules={[{ required: true }]}
        />
        <ProFormText.Password
          name="password"
          fieldProps={{
            size: "large",
            prefix: <LockOutlined />,
            autoComplete: "current-password",
          }}
          placeholder="口令"
          rules={[{ required: true }]}
        />
      </LoginFormPage>
    </main>
  );
}
