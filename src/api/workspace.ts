import type { SupabaseClient } from "@supabase/supabase-js";

export type WorkspaceSettings = {
  onboarding_step?: string;
  persona?: { traits?: string[]; freetext?: string } | null;
  connected_clients?: string[];
  [k: string]: unknown;
};

export type Membership = {
  workspaceId: string;
  name: string;
  settings: WorkspaceSettings;
};

export async function getMembershipForUser(
  sb: SupabaseClient,
  userId: string,
): Promise<Membership | null> {
  const { data, error } = await sb
    .from("workspace_members")
    .select("workspace_id, joined_at, workspaces!inner(id, name, settings)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const ws = (data as any).workspaces;
  return {
    workspaceId: ws.id,
    name: ws.name as string,
    settings: (ws.settings ?? {}) as WorkspaceSettings,
  };
}

export async function patchWorkspaceSettings(
  sb: SupabaseClient,
  workspaceId: string,
  patch: Partial<WorkspaceSettings>,
): Promise<{ settings: WorkspaceSettings; error?: string }> {
  // Read-merge-write. Acceptable for low-write onboarding paths.
  // (For high-contention writes a JSONB merge in a single statement
  // would be safer — revisit if needed.)
  const { data: current, error: readErr } = await sb
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .single();
  if (readErr) return { settings: {}, error: readErr.message };

  const merged = {
    ...((current?.settings ?? {}) as WorkspaceSettings),
    ...patch,
  };

  const { error: writeErr } = await sb
    .from("workspaces")
    .update({ settings: merged })
    .eq("id", workspaceId);
  if (writeErr) return { settings: merged, error: writeErr.message };

  return { settings: merged };
}
