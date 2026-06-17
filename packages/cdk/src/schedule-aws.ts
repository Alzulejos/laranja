import type { Schedule } from "@laranja/core";

/**
 * Lower a provider-neutral Schedule into an AWS EventBridge expression string
 * (`rate(5 minutes)` / `cron(0 12 * * ? *)`). This is the AWS back-half's job —
 * the IR never carries a provider-specific string. AWS requires the singular
 * unit when the value is 1 (`rate(1 minute)`) and plural otherwise.
 */
export function renderAwsSchedule(s: Schedule): string {
  if (s.kind === "cron") return `cron(${s.expression})`;
  const unit = s.value === 1 ? s.unit : `${s.unit}s`;
  return `rate(${s.value} ${unit})`;
}
