/** Alert records contain fixed categories and counts only, never request/error content. */
export type Incident = "payment_ambiguity" | "callback_failure" | "sales_fuse_closed" | "worker_error";
export type IncidentSource = "transition" | "reconciliation" | "fetch" | "scheduled" | "workflow";
export function reportIncident(incident: Incident, source: IncidentSource, count = 1): void {
  try {
    if (!["payment_ambiguity", "callback_failure", "sales_fuse_closed", "worker_error"].includes(incident) ||
        !["transition", "reconciliation", "fetch", "scheduled", "workflow"].includes(source)) return;
    if (!Number.isFinite(count) || count < 1) return;
    console.error({ service: "wait", event: "wait_incident", incident, source, count: Math.max(1, Math.floor(count)) });
  } catch { /* Observability must never change a payment or delivery result. */ }
}

/** Read-only reconciliation covers committed facts whose original log was lost. */
export async function reconcileIncidentMonitoring(db: D1Database, now: Date): Promise<void> {
  try {
    const since = new Date(now.getTime() - 65 * 60 * 1000).toISOString();
    const row = await db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM request_payments WHERE state = 'ambiguous' AND updated_at >= ?) AS payment_ambiguity,
        (SELECT COUNT(*) FROM waits WHERE state = 'delivery_failed' AND terminal_at >= ?) AS callback_failure,
        (SELECT CASE WHEN new_sales_enabled = 0 AND
          (SELECT COUNT(*) FROM request_payments WHERE state = 'ambiguous' AND ambiguity_honored_at IS NOT NULL)
          >= max_ambiguous_payment_honors THEN 1 ELSE 0 END FROM service_controls WHERE id = 1) AS sales_fuse_closed`,
    ).bind(since, since).first<{ payment_ambiguity: number; callback_failure: number; sales_fuse_closed: number | null }>();
    if (!row || ![row.payment_ambiguity, row.callback_failure].every(n => Number.isSafeInteger(n) && n >= 0) || ![0, 1].includes(row.sales_fuse_closed as number)) throw new Error("monitoring_unavailable");
    try { console.log({ service: "wait", event: "wait_monitoring_heartbeat" }); } catch {}
    for (const incident of ["payment_ambiguity", "callback_failure", "sales_fuse_closed"] as const) {
      if (row[incident]! > 0) reportIncident(incident, "reconciliation", row[incident]!);
    }
  } catch { reportIncident("worker_error", "scheduled"); }
}

/** Observe exhausted-and-closed state after a new durable ambiguity, without changing controls. */
export async function reportSalesFuseState(db: D1Database): Promise<void> {
  try {
    const row = await db.prepare(`SELECT new_sales_enabled,
      (SELECT COUNT(*) FROM request_payments WHERE state = 'ambiguous' AND ambiguity_honored_at IS NOT NULL) AS honors,
      max_ambiguous_payment_honors FROM service_controls WHERE id = 1`)
      .first<{ new_sales_enabled: number; honors: number; max_ambiguous_payment_honors: number }>();
    if (!row) throw new Error("monitoring_unavailable");
    if (row.new_sales_enabled === 0 && row.honors >= row.max_ambiguous_payment_honors) reportIncident("sales_fuse_closed", "transition");
  } catch { reportIncident("worker_error", "transition"); }
}
