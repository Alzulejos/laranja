import { NonInteractiveIoHost } from "@aws-cdk/toolkit-lib";
import { dim, green, red, type Spinner } from "./ui.js";

type IoMsg = Parameters<NonInteractiveIoHost["notify"]>[0];

/** The subset of a CloudFormation stack-activity event we surface. */
export interface ResourceActivity {
  event?: {
    ResourceStatus?: string;
    LogicalResourceId?: string;
    ResourceType?: string;
    PhysicalResourceId?: string;
    ResourceStatusReason?: string;
  };
  progress?: { completed?: number; total?: number; formatted?: string };
}

/** Message code the toolkit uses for per-resource CloudFormation stack activity. */
const STACK_ACTIVITY = "CDK_TOOLKIT_I5502";

/**
 * IO host for the CDK toolkit that keeps the console clean: by default it hides
 * CDK's verbose stream, forwards per-resource stack activity to `onActivity`, and
 * only prints errors directly. Pass `verbose` to stream the full CDK output.
 */
export class LaranjaIoHost extends NonInteractiveIoHost {
  /** Called for each CloudFormation resource event during deploy/destroy. */
  public onActivity?: (activity: ResourceActivity) => void;

  constructor(private readonly verbose = false) {
    super();
  }

  override async notify(msg: IoMsg): Promise<void> {
    if (this.verbose) {
      await super.notify(msg);
      return;
    }
    if (msg.code === STACK_ACTIVITY && this.onActivity) {
      this.onActivity(msg.data as ResourceActivity);
      return;
    }
    // Never swallow errors — everything else is intentionally hidden.
    if (msg.level === "error") {
      process.stderr.write(`     ${red("✗")} ${msg.message}\n`);
    }
  }
}

/** Resource types worth announcing as they finish (the rest are infra plumbing). */
const ANNOUNCE: Record<string, string> = {
  "AWS::Lambda::Function": "λ",
  "AWS::SQS::Queue": "📨",
};

/**
 * Build a stack-activity handler that drives a spinner: live N/total progress plus
 * a "✓" line per Lambda/queue as it completes, and a "✗" line on failures.
 */
export function makeActivityHandler(sp: Spinner, verb = "deploying"): (a: ResourceActivity) => void {
  const announced = new Set<string>();
  return (a) => {
    const ev = a.event ?? {};
    const status = ev.ResourceStatus ?? "";
    const progress = a.progress?.total ? `${a.progress.completed}/${a.progress.total}` : (a.progress?.formatted ?? "");
    if (ev.LogicalResourceId) {
      // Keep the live line to a single terminal row. Long logical ids otherwise
      // wrap, which breaks the spinner's in-place redraw (it leaves one wrapped
      // line behind per animation frame). Clip the variable part before styling
      // so we never cut an ANSI escape mid-sequence.
      const detail = `${status} ${ev.LogicalResourceId}`;
      const room = Math.max(12, (process.stdout.columns ?? 80) - verb.length - progress.length - 8);
      const clipped = detail.length > room ? `${detail.slice(0, room - 1)}…` : detail;
      sp.update(`${verb} ${progress}  ${dim(clipped)}`);
    }

    const icon = ANNOUNCE[ev.ResourceType ?? ""];
    if (icon && status.endsWith("_COMPLETE") && !status.startsWith("DELETE") && !announced.has(ev.LogicalResourceId ?? "")) {
      announced.add(ev.LogicalResourceId ?? "");
      const name =
        ev.ResourceType === "AWS::SQS::Queue"
          ? (ev.PhysicalResourceId?.split("/").pop() ?? ev.LogicalResourceId)
          : (ev.PhysicalResourceId ?? ev.LogicalResourceId);
      sp.log(`  ${green("✓")} ${icon} ${name}`);
    }
    if (status.endsWith("_FAILED")) {
      sp.log(`  ${red("✗")} ${ev.LogicalResourceId ?? ""} ${dim(ev.ResourceStatusReason ?? "")}`);
    }
  };
}
