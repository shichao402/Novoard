/**
 * 契约版本（hub 侧单一来源）。
 *
 * 为什么单独一个模块：
 * 版本号此前同时出现在 src/tunnel.mjs 与 scripts/check-contract-copy.mjs，
 * 两处独立维护会产生漂移。现在运行时与门禁都从这里取，升级契约只改这一处。
 *
 * 与文档的一致性：docs/architecture/contracts.md 的「版本：v<X>」必须与本节一致，
 * scripts/check-contract-copy.mjs 会校验这一点。
 * 字面格式统一为不带 `v` 前缀（契约 §0 的 contractVersion pattern 为 ^\d+\.\d+$）。
 */
export const CONTRACT_VERSION = "2.2";
