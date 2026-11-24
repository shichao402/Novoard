import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  type ProColumns,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Popconfirm, Space, Tag, Typography } from "antd";
import {
  apiFetch,
  csrfHeaders,
  type PackSource,
  type PackSourceInput,
} from "@/lib/api";
import { hasPermission, queryKeys, useMe } from "@/lib/queries";

/** 表单值：只提交仓库和分支，branch 为空时交给服务端缺省 main。 */
function clean(values: PackSourceInput, row?: PackSource): PackSourceInput {
  const out: PackSourceInput = {
    git: values.git.trim(),
    branch: values.branch?.trim() || "main",
  };
  // 旧数据里通过接口填过包名覆盖的条目，编辑时原样保留，避免改个分支就把覆盖丢掉
  if (row?.id) {
    out.id = row.id;
    if (row.subdir) out.subdir = row.subdir;
  }
  return out;
}

function describe(row: PackSource) {
  return `${row.git}@${row.branch}`;
}

/**
 * 能力包来源页（PRD-6 H3/H5，契约 v2.7）。来源全局一份，随 agent.hello.ack 下发给所有成员。
 * 只填仓库地址和分支：agent 拉下仓库后扫描所有 toolset.json，子目录和包名都不用填；
 * 是否把仓库里的包全部自动装上，由各 agent 在本机能力包页的「自动添加」开关决定。
 */
export default function PackSourcesPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const canManage = hasPermission(me.data, "pack-sources.manage");

  const sources = useQuery({
    queryKey: queryKeys.packSources,
    queryFn: () => apiFetch<{ sources: PackSource[] }>("/api/pack-sources"),
  });

  const headers = () => csrfHeaders(me.data?.csrfToken ?? "");
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.packSources });

  const save = useMutation({
    mutationFn: ({
      key,
      body,
    }: {
      key?: string | undefined;
      body: PackSourceInput;
    }) =>
      apiFetch<{ source: PackSource }>(
        key
          ? `/api/pack-sources/${encodeURIComponent(key)}`
          : "/api/pack-sources",
        {
          method: key ? "PUT" : "POST",
          headers: headers(),
          body: JSON.stringify(body),
        },
      ),
    onSuccess: async (_result, { key }) => {
      await refresh();
      message.success(key ? "来源已更新" : "来源已新增");
    },
    onError: (error: Error) => message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (key: string) =>
      apiFetch<{ removed: boolean }>(
        `/api/pack-sources/${encodeURIComponent(key)}`,
        { method: "DELETE", headers: headers() },
      ),
    onSuccess: async () => {
      await refresh();
      message.success("来源已删除");
    },
    onError: (error: Error) => message.error(error.message),
  });

  async function submit(values: PackSourceInput, row?: PackSource) {
    try {
      await save.mutateAsync({ key: row?.key, body: clean(values, row) });
      return true;
    } catch {
      return false;
    }
  }

  const columns: ProColumns<PackSource>[] = [
    {
      title: "仓库",
      dataIndex: "git",
      render: (_, row) => (
        <Space size={4} wrap>
          <Typography.Text copyable>{row.git}</Typography.Text>
          {row.id ? (
            <Tag color="blue">
              包名覆盖 {row.id}
              {row.subdir ? ` / ${row.subdir}` : ""}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    { title: "分支", dataIndex: "branch" },
    {
      title: "操作",
      key: "actions",
      render: (_, row) =>
        canManage ? (
          <Space>
            <ModalForm<PackSourceInput>
              title="编辑来源"
              initialValues={row}
              modalProps={{ destroyOnHidden: true }}
              submitter={{ searchConfig: { submitText: "保存" } }}
              trigger={
                <Button size="small" icon={<EditOutlined />}>
                  编辑
                </Button>
              }
              onFinish={(values) => submit(values, row)}
            >
              <SourceFields />
            </ModalForm>
            <Popconfirm
              title={`删除来源 ${describe(row)}？已安装的包不受影响，但无法再安装或更新。`}
              okText="确认删除"
              onConfirm={() => remove.mutate(row.key)}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ) : null,
    },
  ];

  return (
    <PageContainer
      title="能力包来源"
      subTitle="只登记 git 仓库，agent 自己扫描仓库里的能力包"
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="修改后，成员重连或主动同步时生效。"
          description="agent 拉下仓库后会扫描所有 toolset.json，在本机能力包页列出可装的包；在那里打开「自动添加」，仓库里的包（包括以后新加的）会自己装上。私有仓库请在 agent 本机的「设置 → Git 凭据」配置，凭据不经过 Hub。"
        />
        <ProTable<PackSource>
          rowKey="key"
          search={false}
          options={false}
          pagination={false}
          loading={sources.isPending}
          dataSource={sources.data?.sources ?? []}
          columns={columns}
          toolBarRender={() =>
            canManage
              ? [
                  <ModalForm<PackSourceInput>
                    key="add"
                    title="新增能力包来源"
                    initialValues={{ branch: "main" }}
                    modalProps={{ destroyOnHidden: true }}
                    submitter={{ searchConfig: { submitText: "保存" } }}
                    trigger={
                      <Button type="primary" icon={<PlusOutlined />}>
                        新增来源
                      </Button>
                    }
                    onFinish={(values) => submit(values)}
                  >
                    <SourceFields />
                  </ModalForm>,
                ]
              : []
          }
        />
      </Space>
    </PageContainer>
  );
}

function SourceFields() {
  return (
    <>
      <ProFormText
        name="git"
        label="仓库地址"
        placeholder="https://github.com/group/repo.git"
        tooltip="公开仓可用 HTTPS；私有仓有本机 SSH 权限时优先 SSH，否则在 agent 本机配置 Git 凭据，勿把 token 写进地址"
        rules={[
          { required: true, whitespace: true, message: "请输入仓库地址" },
        ]}
      />
      <ProFormText
        name="branch"
        label="分支"
        rules={[{ required: true, whitespace: true, message: "请输入分支" }]}
      />
    </>
  );
}
