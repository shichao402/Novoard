/**
 * hub 推荐的 agent 程序版本（契约 v2.8，agent.hello.ack / nack 的 recommendedAgentVersion）。
 *
 * 为什么由 hub 声明：agent 的桌面壳只按自己的节奏轮询 relkit，契约升级后旧 agent 要等到
 * 下一次轮询才发现新版；hub 握手时直接告诉它「该到哪个版本」，低于这个版本的 agent
 * 立刻检查并在空闲时自动安装（agent ADR-0022）。
 *
 * 维护方式：发 agent 正式版后，把这里改成该版本再发 hub；只发 agent、不发 hub 时不必改，
 * agent 自己的定时检查会跟上。紧急情况可用环境变量 NOVOARD_RECOMMENDED_AGENT_VERSION
 * 覆盖，免重新打镜像。空串表示不推荐，握手帧不带该字段。
 */
const SEMVER = /^\d+\.\d+\.\d+$/;

export const RECOMMENDED_AGENT_VERSION = "0.3.14";

export function recommendedAgentVersion(env = process.env) {
  const override = String(env.NOVOARD_RECOMMENDED_AGENT_VERSION ?? "").trim();
  if (override) return SEMVER.test(override) ? override : "";
  return RECOMMENDED_AGENT_VERSION;
}

/** 握手帧里展开用：没有推荐版本时返回空对象，帧里不出现该字段。 */
export function recommendedAgentVersionField(env = process.env) {
  const version = recommendedAgentVersion(env);
  return version ? { recommendedAgentVersion: version } : {};
}
