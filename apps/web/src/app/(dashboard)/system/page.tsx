import { ModulePage } from "@/components/module-page";

export const metadata = { title: "System Monitoring" };

export default function SystemPage() {
  return (
    <ModulePage
      title="System Monitoring"
      module="Platform"
      phase="Phase 1"
      description="Health of every component: exchange connectors, data-quality scores, queue depths, job runs, and service liveness. Degraded data quality freezes signal generation — visibly."
      widgets={[
        { title: "Service Health", detail: "Postgres, Redis, quant service, ingestion connectors, worker queues." },
        { title: "Data Quality", detail: "Latest DQ scores per exchange/symbol/timeframe with check breakdowns." },
        { title: "Connector Status", detail: "WebSocket liveness, heartbeat gaps, backfill progress per exchange." },
        { title: "Job Runs", detail: "Cron and queue job history with failures surfaced." },
        { title: "Queue Depths", detail: "BullMQ backlog and dead-letter monitoring." },
        { title: "Alert Inbox", detail: "Detector and system alerts with severity and read state." },
      ]}
    />
  );
}
