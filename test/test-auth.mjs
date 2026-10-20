import { hashAgentToken } from "../src/agent-auth.mjs";

export const TEST_USERNAME = "test-owner";
export const TEST_PASSWORD = "test owner password 123";

export async function bootstrapTestAuth(hub, {
  username = TEST_USERNAME,
  password = TEST_PASSWORD,
  name = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
} = {}) {
  const status = await hub.identity.setupStatus();
  const session = status.required
    ? await hub.identity.setup({ username, displayName: "Test Owner", password })
    : await hub.identity.login({ username, password });
  if (!session) throw new Error("测试身份登录失败");
  const owner = await hub.identity.authenticateSession(session.token);
  const issued = await hub.identity.createPat(owner, { name });
  return {
    owner,
    session,
    pat: issued.pat,
    token: issued.token,
    authorization: `Bearer ${issued.token}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issued.token}`,
    },
  };
}

/**
 * 测试专用：把 agentId → 明文 token 写进成员目录（只存哈希，与生产签发路径同构）。
 * 走 members.adoptTokenHash 而不是直接改 secrets，保证测试与运行期共用同一个 SSOT。
 */
export function configureTestAgentTokens(hub, tokensByAgent) {
  for (const [agentId, token] of Object.entries(tokensByAgent)) {
    hub.members.adoptTokenHash(agentId, hashAgentToken(token));
  }
}
