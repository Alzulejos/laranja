import { CfnOutput, CfnParameter, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  HttpMethod,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { Construct } from "constructs";
import { envParamName, handlerLabel, handlerName, type InfraIR } from "@laranja/core";
import type { BundledHandler } from "./bundle.js";
import { renderAwsSchedule } from "./schedule-aws.js";

export interface LaranjaStackProps extends StackProps {
  ir: InfraIR;
  handlers: BundledHandler[];
}

/** Strip a logical id down to CloudFormation-safe alphanumerics. */
function cid(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * The CDK stack generated from an Infra IR.
 *
 *   HTTP   -> one proxy Lambda + Function URL (no API Gateway)
 *   Cron   -> one Lambda + EventBridge schedule rule each
 *   Queue  -> one SQS queue + consumer Lambda each (partial-batch failures on)
 */
export class LaranjaStack extends Stack {
  constructor(scope: Construct, id: string, props: LaranjaStackProps) {
    super(scope, id, props);
    const { ir, handlers } = props;
    const byId = new Map(handlers.map((h) => [h.id, h]));

    // Code-discovered env("NAME") keys become CloudFormation Parameters: the
    // value is supplied at deploy time (from the client's process.env) and never
    // baked into the template. `default: ""` lets a first deploy succeed even if
    // a value is unset (the client warns); on later deploys an unspecified value
    // keeps the previous one (UsePreviousValue). noEcho keeps values out of the
    // console/events. Config statics (ir.env) are still inlined as literals.
    const lambdaEnv: Record<string, string> = { ...ir.env };
    for (const key of ir.envKeys) {
      const param = new CfnParameter(this, envParamName(key), {
        type: "String",
        default: "",
        noEcho: true,
        description: `Value for env("${key}") — supplied at deploy time.`,
      });
      lambdaEnv[key] = param.valueAsString;
    }

    // Physical Lambda name: <app>-<label>-<stage>, e.g. "express-basic-app-dev".
    const fnName = (label: string): string =>
      `${ir.app.name}-${label}-${ir.app.stage}`.replace(/[^A-Za-z0-9-_]/g, "-").slice(0, 64);

    const makeFn = (logicalId: string, handlerId: string, label: string, timeout: Duration): LambdaFunction => {
      const h = byId.get(handlerId);
      if (!h) throw new Error(`No bundled handler for "${handlerId}"`);
      return new LambdaFunction(this, logicalId, {
        functionName: fnName(label),
        runtime: Runtime.NODEJS_20_X,
        code: Code.fromAsset(h.assetDir),
        handler: h.handler,
        environment: lambdaEnv,
        timeout,
      });
    };

    // --- HTTP: single proxy Lambda + Function URL (skipped for workers-only apps) ---
    if (ir.http) {
      const httpFn = makeFn("HttpFn", "http", "app", Duration.seconds(30));
      const fnUrl = httpFn.addFunctionUrl({
        authType: FunctionUrlAuthType.NONE,
        cors: {
          allowedOrigins: ["*"],
          allowedMethods: [HttpMethod.ALL],
          allowedHeaders: ["*"],
        },
      });
      new CfnOutput(this, "HttpUrl", { value: fnUrl.url, description: "Public HTTPS endpoint (proxy Lambda)" });
      new CfnOutput(this, "HttpRoutes", { value: String(ir.http.routes.length), description: "Routes served by the proxy" });
    }

    // --- Cron: Lambda + EventBridge rule each ---
    for (const cron of ir.crons) {
      // Use the handler name, unless the user set an explicit id.
      const fn = makeFn(`Cron${cid(cron.id)}Fn`, cron.id, handlerLabel(cron), Duration.seconds(60));
      new Rule(this, `Cron${cid(cron.id)}Rule`, {
        schedule: Schedule.expression(renderAwsSchedule(cron.schedule)),
        targets: [new LambdaTarget(fn)],
      });
    }

    // --- Queues: SQS + consumer Lambda each ---
    for (const q of ir.queues) {
      const consumerTimeout = Duration.seconds(30);
      const queue = new Queue(this, `Queue${cid(q.id)}`, {
        queueName: q.name,
        fifo: q.fifo || undefined,
        contentBasedDeduplication: q.fifo ? true : undefined,
        encryption: QueueEncryption.SQS_MANAGED,
        // AWS requires visibility timeout >= function timeout; use the 6x guidance.
        visibilityTimeout: Duration.seconds(consumerTimeout.toSeconds() * 6),
      });
      const fn = makeFn(`Consumer${cid(q.id)}Fn`, q.id, handlerName(q), consumerTimeout);
      fn.addEventSource(
        new SqsEventSource(queue, {
          batchSize: q.batchSize ?? 10,
          reportBatchItemFailures: true,
        }),
      );
      new CfnOutput(this, `Queue${cid(q.id)}Url`, { value: queue.queueUrl, description: `SQS URL for ${q.name}` });
    }
  }
}
