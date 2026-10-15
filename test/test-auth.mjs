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

export function configureTestAgentTokens(hub, tokensByAgent) {
  hub.secrets.set({
    agentTokenHashes: Object.fromEntries(
      Object.entries(tokensByAgent).map(([agentId, token]) => [agentId, hashAgentToken(token)]),
    ),
  });
}
