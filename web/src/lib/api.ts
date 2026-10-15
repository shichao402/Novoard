export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly payload: unknown,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  const text = await response.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(payload?.error ?? "request_failed"),
      String(payload?.message ?? payload?.error ?? `HTTP ${response.status}`),
      payload,
    );
  }
  return payload as T;
}

export function csrfHeaders(csrfToken: string): HeadersInit {
  return {
    "X-CSRF-Token": csrfToken,
  };
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  accountType: "human" | "service";
  roleId: string;
  disabled: boolean;
  forcePasswordChange: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Role {
  id: string;
  name: string;
  builtIn: boolean;
  permissions: string[];
  targetAllow: string[];
  targetDeny: string[];
}

export interface Me {
  user: User;
  role: Role;
  permissions: string[];
  csrfToken: string;
}

export interface Pat {
  id: string;
  userId: string;
  username: string;
  name: string;
  kind: "personal" | "service";
  tokenLastFour: string;
  scopes: string[];
  targetAllow: string[];
  targetDeny: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface TargetSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface TargetMember {
  agentId: string;
  name: string;
  online: boolean;
  skills: TargetSkill[];
}

export interface Task {
  id: string;
  target: string;
  member: string;
  actor: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  artifacts?: Array<{
    name: string;
    parts: Array<{ kind: string; uri?: string; text?: string }>;
  }>;
}

export interface AuditEvent {
  ts: string;
  actor: string;
  lane: string;
  target: string;
  taskId?: string;
  outcome: string;
  detail?: Record<string, unknown>;
}

export interface WecomConfig {
  botId: string;
  botSecretConfigured: boolean;
  allowedUserIds: string[];
  allowedChatIds: string[];
  notifyChatId: string;
  servicePatConfigured: boolean;
  servicePatId: string | null;
  serviceAccount: User | null;
}
