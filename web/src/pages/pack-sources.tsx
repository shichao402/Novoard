import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  type ProColumns,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Popconfirm, Space, Typography } from "antd";
import { apiFetch, csrfHeaders, type PackSource } from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

/** 与服务端 pack-sources.mjs、契约 hello.ack packSources.items.id 同一条规则。 */
const PACK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

type SourceInput = Omit<PackSource, "id">;

/**
 * 能力包来源页（PRD-6 H3）。来源全局一份，随 agent.hello.ack 下发给所有成员。
 * id 只在新增时输入一次；编辑、删除在列表行上操作，不再手输 id。
 */
export default function PackSourcesPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const sources = useQuery({
    queryKey: queryKeys.packSources,
    queryFn: () => apiFetch<{ sources: PackSource[] }>("/api/pack-sources"),
  });
  const existingIds = new Set((sources.data?.sources ?? []).map((s) => s.id));

  const save = useMutation({
    mutationFn: ({ id, ...body }: PackSource) =>
      apiFetch<{ source: PackSource; created: boolean }>(
        `/api/pack-sources/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          headers: csrfHeaders(me.data?.csrfToken ?? ""),
          body: JSON.stringify(body),
        },
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.packSources });
      message.success(
        result.created
          ? `已新增来源 ${result.source.id}`
          : `已更新来源 ${result.source.id}`,
      );
    },
    onError: (error: Error) => message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ removed: boolean }>(
        `/api/pack-sources/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: csrfHeaders(me.data?.csrfToken ?? ""),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.packSources });
      message.success("来源已删除");
    },
    onError: (error: Error) => message.error(error.message),
  });

  async function submit(source: PackSource) {
    const subdir = source.subdir?.trim();
    const { subdir: _drop, ...rest } = source;
    try {
      await save.mutateAsync(subdir ? { ...rest, subdir } : rest);
      return true;
    } catch {
      return false;
    }
  }

  const columns: ProColumns<PackSource>[] = [
    { title: "id", dataIndex: "id", copyable: true },
    { title: "git", dataIndex: "git", copyable: true, ellipsis: true },
    { title: "branch", dataIndex: "branch" },
    {
      title: "subdir",
      dataIndex: "subdir",
      render: (_, row) => row.subdir || "（仓库根）",
    },
    {
      title: "操作",
      key: "actions",
      render: (_, row) => (
        <Space>
          <ModalForm<SourceInput>
            title={`编辑来源 ${row.id}`}
            initialValues={row}
            modalProps={{ destroyOnHidden: true }}
            submitter={{ searchConfig: { submitText: "保存" } }}
            trigger={
              <Button size="small" icon={<EditOutlined />}>
                编辑
              </Button>
            }
            onFinish={(values) => submit({ ...values, id: row.id })}
          >
            <SourceFields />
          </ModalForm>
          <Popconfirm
            title={`删除来源 ${row.id}？已安装该包的成员不受影响，但无法再安装或更新。`}
            okText="确认删除"
            onConfirm={() => remove.mutate(row.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="能力包来源"
      subTitle="agent 按这里的清单用 git 安装、更新能力包"
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Alert type="info" showIcon message="修改后，在线成员重连时生效。" />
        <ProTable<PackSource>
          rowKey="id"
          search={false}
          options={false}
          pagination={false}
          loading={sources.isPending}
          dataSource={sources.data?.sources ?? []}
          columns={columns}
          toolBarRender={() => [
            <ModalForm<PackSource>
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
              onFinish={submit}
            >
              <ProFormText
                name="id"
                label="id"
                tooltip="能力包 id，target 里写成 uses: <id>/<工具>"
                fieldProps={{ autoComplete: "off" }}
                rules={[
                  { required: true, message: "请输入 id" },
                  {
                    pattern: PACK_ID_PATTERN,
                    message: "字母开头，只含字母、数字和 -",
                  },
                  {
                    validator: (_, value) =>
                      value && existingIds.has(value)
                        ? Promise.reject(
                            new Error("该 id 已存在，请在列表里编辑"),
                          )
                        : Promise.resolve(),
                  },
                ]}
                validateTrigger={["onChange", "onBlur"]}
              />
              <SourceFields />
            </ModalForm>,
          ]}
        />
        <Typography.Text type="secondary">
          agent 收到清单后缓存到本机，离线时沿用缓存。
        </Typography.Text>
      </Space>
    </PageContainer>
  );
}

function SourceFields() {
  return (
    <>
      <ProFormText
        name="git"
        label="git"
        placeholder="git@git.woa.com:group/repo.git"
        rules={[
          { required: true, whitespace: true, message: "请输入仓库地址" },
        ]}
      />
      <ProFormText
        name="branch"
        label="branch"
        rules={[{ required: true, whitespace: true, message: "请输入分支" }]}
      />
      <ProFormText
        name="subdir"
        label="subdir"
        placeholder="留空表示仓库根"
        tooltip="包根在仓库内的相对路径"
      />
    </>
  );
}
