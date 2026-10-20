import { useQuery } from "@tanstack/react-query";
import { apiFetch, type Me } from "./api";

export const queryKeys = {
  setup: ["setup-status"] as const,
  me: ["me"] as const,
  users: ["users"] as const,
  roles: ["roles"] as const,
  pats: ["pats"] as const,
  tasks: ["tasks"] as const,
  targets: ["targets"] as const,
  members: ["members"] as const,
  events: ["events"] as const,
  status: ["status"] as const,
  wecom: ["wecom"] as const,
};

export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.setup,
    queryFn: () => apiFetch<{ required: boolean }>("/api/setup/status"),
    staleTime: 0,
  });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiFetch<Me>("/api/me"),
    enabled,
    retry: false,
    staleTime: 5_000,
  });
}

export function hasPermission(me: Me | undefined, permission: string) {
  return !!me?.permissions.includes(permission);
}
