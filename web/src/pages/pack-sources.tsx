import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  ModalForm,
  PageContainer,
  type ProColumns,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Collapse,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  apiFetch,
  csrfHeaders,
  type PackSource,
  type PackSourceInput,
} from "@/lib/api";
import { queryKeys, useMe } from "@/lib/queries";

/** 与服务端 pack-sources.mjs、契约 hello.ack packSources.items.id 同一条规则。 */
const PACK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

/** 表单值：空串字段在提交前剔除，交给服务端缺省（branch→main，id→自动发现）。 */
function clean(values: PackSourceInput): PackSourceInput {
  const out: PackSourceInput = {
    git: values.git.trim(),
    branch: values.branch?.trim() || "main",
  };
  const subdir = values.subdir?.trim();
  const id = values.id?.trim();
  if (subdir) out.subdir = subdir;
  if (id) out.id = id;
  return out;
}

function describe(row: PackSource) {
  return `${row.git}${row.subdir ? ` / ${row.subdir}` : ""}@${row.branch}`;
}

/**
 * 能力包来源页（PRD-6 H3/H5）。来源全局一份，随 agent.hello.ack 下发给所有成员。
 * 只填仓库地址、子目录、分支；包名由 agent 安装时从 toolset.json 自动发现，
 * 只有同一个包要从两个分支并装这类重名场景，才在「高级」里填包名覆盖。
 */
export default function PackSourcesPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

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

  async function submit(values: PackSourceInput, key?: string) {
    try {
      await save.mutateAsync({ key, body: clean(values) });
      return true;
    } catch {
      return false;
    }
  }

  const columns: ProColumns<PackSource>[] = [
    { title: "仓库", dataIndex: "git", copyable: true, ellipsis: true },
    {
      title: "子目录",
      dataIndex: "subdir",
      render: (_, row) => row.subdir || "（仓库根）",
    },
    { title: "分支", dataIndex: "branch" },
    {
      title: "包名",
      dataIndex: "id",
      render: (_, row) =>
        row.id ? (
          <Tag color="blue">{row.id}</Tag>
        ) : (
          <Typography.Text type="secondary">自动</Typography.Text>
        ),
    },
    {
      title: "操作",
      key: "actions",
      render: (_, row) => (
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
            onFinish={(values) => submit(values, row.key)}
          >
            <SourceFields advancedOpen={Boolean(row.id)} />
          </ModalForm>
          <Popconfirm
            title={`删除来源 ${describe(row)}？已安装该包的成员不受影响，但无法再安装或更新。`}
            okText="确认删除"
            onConfirm={() => remove.mutate(row.key)}
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
        <Alert
          type="info"
          showIcon
          message="修改后，在线成员重连时生效。"
          description="仓库默认按公开仓库拉取；私有仓库请在对应 agent 本机的「设置 → Git 凭据」里配置，凭据不经过 Hub。"
        />
        <ProTable<PackSource>
          rowKey="key"
          search={false}
          options={false}
          pagination={false}
          loading={sources.isPending}
          dataSource={sources.data?.sources ?? []}
          columns={columns}
          toolBarRender={() => [
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
              <SourceFields advancedOpen={false} />
            </ModalForm>,
          ]}
        />
        <Typography.Text type="secondary">
          包名会在 agent 安装时从包根的 toolset.json 自动读取；agent
          收到清单后缓存到本机，离线时沿用缓存。
        </Typography.Text>
      </Space>
    </PageContainer>
  );
}

function SourceFields({ advancedOpen }: { advancedOpen: boolean }) {
  return (
    <>
      <ProFormText
        name="git"
        label="仓库地址"
        placeholder="https://github.com/group/repo.git"
        tooltip="推荐 HTTPS 地址；私有仓库的凭据在 agent 本机按 URL 配置"
        rules={[
          { required: true, whitespace: true, message: "请输入仓库地址" },
        ]}
      />
      <ProFormText
        name="subdir"
        label="子目录"
        placeholder="留空表示仓库根，例如 packs/versionControl"
        tooltip="包根（toolset.json 所在目录）在仓库内的相对路径"
      />
      <ProFormText
        name="branch"
        label="分支"
        rules={[{ required: true, whitespace: true, message: "请输入分支" }]}
      />
      <Collapse
        ghost
        size="small"
        defaultActiveKey={advancedOpen ? ["advanced"] : []}
        items={[
          {
            key: "advanced",
            label: "高级",
            forceRender: true,
            children: (
              <ProFormText
                name="id"
                label="包名覆盖"
                placeholder="留空则自动读取 toolset.json 的 id"
                tooltip="只在同一个包要从两个来源并装（如 main 与 dev 分支）时填写；target 里写成 uses: <包名>/<工具>"
                fieldProps={{ autoComplete: "off" }}
                rules={[
                  {
                    pattern: PACK_ID_PATTERN,
                    message: "字母开头，只含字母、数字和 -",
                  },
                ]}
                validateTrigger={["onChange", "onBlur"]}
              />
            ),
          },
        ]}
      />
    </>
  );
}
