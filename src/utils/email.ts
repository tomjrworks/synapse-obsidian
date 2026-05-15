import { Resend } from "resend";

function resendClient(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

const FROM_ADDRESS =
  process.env.EMAIL_FROM ?? "Taproot <noreply@taproothq.com>";

export async function sendTrialEndedEmail(toEmail: string): Promise<void> {
  const resend = resendClient();
  await resend.emails.send({
    from: FROM_ADDRESS,
    to: toEmail,
    subject: "Your Taproot trial ended — 7 days to keep going",
    html: `
      <p>Hey — your 30-day Taproot trial just ended.</p>
      <p>You have a <strong>7-day grace window</strong> — your files and sync keep working until then.</p>
      <p>
        <a href="https://taproothq.com/dashboard/billing" style="background:#1a1a1a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
          Subscribe to keep going →
        </a>
      </p>
      <p style="color:#666;font-size:13px;">$12/month or $99/year. Cancel anytime.</p>
    `,
  });
}

export async function sendTrialWarningEmail(
  toEmail: string,
  daysRemaining: number,
): Promise<void> {
  const resend = resendClient();
  const dayWord = daysRemaining === 1 ? "day" : "days";

  await resend.emails.send({
    from: FROM_ADDRESS,
    to: toEmail,
    subject: `Your Taproot trial ends in ${daysRemaining} ${dayWord}`,
    html: `
      <p>Hey — your Taproot trial ends in <strong>${daysRemaining} ${dayWord}</strong>.</p>
      <p>After that, syncing and MCP tools will pause. Your files stay on your Mac.</p>
      <p>
        <a href="https://taproothq.com/dashboard/settings" style="background:#1a1a1a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
          Subscribe to keep going →
        </a>
      </p>
      <p style="color:#666;font-size:13px;">$12/month or $99/year. Cancel anytime.</p>
    `,
  });
}
