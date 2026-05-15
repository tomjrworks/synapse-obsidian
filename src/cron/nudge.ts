import cron from "node-cron";
import { supabaseService } from "../api/supabase.js";
import { getMembershipForWorkspace } from "../api/workspace.js";
import { sendTrialEndedEmail } from "../utils/email.js";

export interface NudgeResult {
  sent: number;
  errors: number;
}

// Finds workspaces whose trial ended yesterday and sends a day-31 nudge email.
// The date-range query (trial_ends_at in [yesterday 00:00, today 00:00)) ensures
// each workspace is only targeted once — on the day after trial_ends_at.
export async function runDayThirtyOneNudge(): Promise<NudgeResult> {
  const sb = supabaseService();
  const now = new Date();

  const todayMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const yesterdayMidnight = new Date(
    todayMidnight.getTime() - 24 * 60 * 60 * 1000,
  );

  const { data: rows, error } = await sb
    .from("workspace_subscriptions")
    .select("workspace_id")
    .eq("status", "trialing")
    .gte("trial_ends_at", yesterdayMidnight.toISOString())
    .lt("trial_ends_at", todayMidnight.toISOString());

  if (error) {
    console.error("[nudge] query error:", error);
    return { sent: 0, errors: 1 };
  }

  let sent = 0;
  let errors = 0;

  for (const row of rows ?? []) {
    try {
      const membership = await getMembershipForWorkspace(sb, row.workspace_id);
      if (!membership?.userId) continue;
      const {
        data: { user },
      } = await supabaseService().auth.admin.getUserById(membership.userId);
      if (!user?.email) continue;
      await sendTrialEndedEmail(user.email);
      sent++;
    } catch (err) {
      console.error(`[nudge] failed for workspace ${row.workspace_id}:`, err);
      errors++;
    }
  }

  console.log(`[nudge] day-31 run complete: sent=${sent} errors=${errors}`);
  return { sent, errors };
}

// Starts the daily 09:00 UTC cron. Call once at server startup.
export function startNudgeCron(): void {
  cron.schedule(
    "0 9 * * *",
    () => {
      runDayThirtyOneNudge().catch((err) =>
        console.error("[nudge] unhandled cron error:", err),
      );
    },
    { timezone: "UTC" },
  );
  console.log("[nudge] day-31 cron scheduled (09:00 UTC daily)");
}
