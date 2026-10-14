/**
 * 信封与帧校验（契约 §3 §4，schemas/ 冻结基线）。
 * ajv 以 draft 2020-12 入口加载 docs/architecture/schemas/ 九张 schema：
 * 先 addSchema 全量注册（$ref 跨文件解析依赖注册顺序，先注册后取编译器），再按名取用。
 * 说明：`format: "date-time"` 未接 ajv-formats（依赖面封顶三个），ts 按不透明字符串处理。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";

const SCHEMA_DIR = schemaDirFromModuleUrl();

/**
 * 模块相对路径锚定：dev 读盘（src/../docs/…）；SEA/打包形态 import.meta.url 不可用时退 cwd。
 * （CJS bundle 中 import.meta 为空对象——esbuild 警告口径；frames 仅在无内嵌 schema 时才触达读盘路径）
 */
function schemaDirFromModuleUrl() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "docs", "architecture", "schemas");
  } catch {
    return join(process.cwd(), "docs", "architecture", "schemas");
  }
}

/**
 * SEA 二进制形态（M6 F2）：docs/ 不进 bundle，九张 schema 由构建期嵌入
 * （build/embedded-schemas.gen.mjs，sea-entry 注入 globalThis）。
 * 校验逻辑与 dev 完全同一条路——仅数据源从读盘换成内嵌对象，编译与判据零差异。
 * 惰性求值：sea-entry 与 frames 的模块求值顺序不确定（bundle 依赖图排布），调用时读 globalThis 才稳。
 */
const embeddedSchemas = () => globalThis.__NOVOARD_EMBEDDED_SCHEMAS__ ?? null;

const SCHEMA_FILES = {
  envelope: "novoard/a2a-envelope.json",
  agentHello: "novoard/frame-agent-hello.json",
  agentPing: "novoard/frame-agent-ping.json",
  telemetry: "novoard/frame-telemetry.json",
  cardUpdate: "novoard/frame-card-update.json",
  agentCard: "novoard/agent-card.json",
  task: "novoard/task.json",
  auditEvent: "novoard/audit-event.json",
  target: "novoard/target.json",
};

const FILE_BY_ID = {
  "novoard/a2a-envelope.json": "a2a-envelope.json",
  "novoard/frame-agent-hello.json": "frame-agent-hello.json",
  "novoard/frame-agent-ping.json": "frame-agent-ping.json",
  "novoard/frame-telemetry.json": "frame-telemetry.json",
  "novoard/frame-card-update.json": "frame-card-update.json",
  "novoard/agent-card.json": "agent-card.json",
  "novoard/task.json": "task.json",
  "novoard/audit-event.json": "audit-event.json",
  "novoard/target.json": "target.json",
};

export function createFrameValidator({ schemaDir = SCHEMA_DIR, schemas = embeddedSchemas() } = {}) {
  const ajv = new Ajv({ allErrors: true, strict: false });

  // 全量注册（$id 已在文件内声明），注册阶段不编译，$ref 跨文件可解析
  // 数据源二选一：内嵌（SEA 二进制）或读盘（dev / 测试注入）
  for (const [id, file] of Object.entries(FILE_BY_ID)) {
    const schema = schemas ? schemas[FILE_BY_ID[id]] : JSON.parse(readFileSync(join(schemaDir, file), "utf8"));
    ajv.addSchema(schema, id);
  }

  const compiled = {};
  for (const key of Object.keys(SCHEMA_FILES)) {
    compiled[key] = ajv.getSchema(SCHEMA_FILES[key]);
  }

  return {
    /** 校验隧道信封（v/kind/msgId + kind 条件约束）。 */
    envelope(frame) {
      return result(compiled.envelope, frame);
    },
    /** 校验 ops 帧 body（按 type 分派）。 */
    opsBody(type, body) {
      const key = { "agent.hello": "agentHello", "agent.ping": "agentPing", telemetry: "telemetry", "card.update": "cardUpdate" }[type];
      if (!key) return { ok: false, errors: [`unknown ops type: ${type}`] };
      return result(compiled[key], body);
    },
    /** 校验 Agent Card（单成员或聚合）。 */
    agentCard(card) {
      return result(compiled.agentCard, card);
    },
    /** 校验 A2A task 对象。 */
    task(taskObj) {
      return result(compiled.task, taskObj);
    },
    /** 校验审计事件行。 */
    auditEvent(event) {
      return result(compiled.auditEvent, event);
    },
    /** 校验 agent targets 定义（YAML 转 JSON 后，纪律一启动自检同款）。 */
    targets(data) {
      return result(compiled.target, data);
    },
  };
}

function result(validate, data) {
  if (!validate) return { ok: false, errors: ["schema 未加载"] };
  const pass = validate(data);
  if (!pass) {
    return { ok: false, errors: validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`) };
  }
  return { ok: true, errors: [] };
}
