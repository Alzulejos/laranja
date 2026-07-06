import { describe, test, expect, afterEach } from "vitest";
import { scan } from "@alzulejos/laranja-scanner";
import { makeProject, cleanupProjects, cfg } from "./helpers.js";

afterEach(cleanupProjects);

describe("class / decorator style", () => {
  test("discovers @Cron and @Queue as method-style handlers", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, Queue, rate } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron(rate(5, "minutes"))
          async refreshCache() {}
          @Queue({ name: "emails", batchSize: 10 })
          async sendEmails() {}
        }
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });

    expect(ir.crons).toHaveLength(1);
    expect(ir.crons[0]).toMatchObject({
      style: "method",
      className: "Jobs",
      method: "refreshCache",
      id: "Jobs-refreshCache",
      schedule: { kind: "rate", value: 5, unit: "minute" },
    });
    expect(ir.queues[0]).toMatchObject({
      style: "method",
      className: "Jobs",
      method: "sendEmails",
      name: "emails",
      batchSize: 10,
    });
  });

  test("@Queue({ fifo: true }) appends the .fifo suffix to the name", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Queue } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Queue({ name: "emails", fifo: true })
          async sendEmails() {}
        }
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.queues[0]).toMatchObject({ name: "emails.fifo", fifo: true });
  });

  test("honors an explicit @Cron id and folds every()", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, every } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron({ schedule: every("day"), id: "nightly" })
          async run() {}
        }
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.crons[0]).toMatchObject({ id: "nightly", schedule: { kind: "rate", value: 1, unit: "day" } });
  });
});

describe("function / marker style", () => {
  test("discovers cron() and queue() as function-style handlers", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, queue, rate } from "@alzulejos/laranja-decorators";
        export async function refreshCache() {}
        export async function sendEmails() {}
        cron(rate(5, "minutes"), refreshCache);
        queue({ name: "orders.fifo" }, sendEmails);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });

    expect(ir.crons[0]).toMatchObject({
      style: "function",
      exportName: "refreshCache",
      id: "refreshCache",
      schedule: { kind: "rate", value: 5, unit: "minute" },
    });
    expect(ir.queues[0]).toMatchObject({
      style: "function",
      exportName: "sendEmails",
      name: "orders.fifo",
      fifo: true, // inferred from the .fifo suffix
    });
  });

  test("appends the .fifo suffix when fifo: true but the name lacks it", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { queue } from "@alzulejos/laranja-decorators";
        export async function fifoHandler() {}
        queue({ name: "fifoHandler", batchSize: 1, fifo: true }, fifoHandler);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.queues[0]).toMatchObject({
      name: "fifoHandler.fifo", // AWS requires the suffix; normalized here, not at deploy
      fifo: true,
      batchSize: 1,
    });
  });

  test("leaves a .fifo name untouched (no double suffix)", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { queue } from "@alzulejos/laranja-decorators";
        export async function h() {}
        queue({ name: "orders.fifo", fifo: true }, h);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.queues[0]).toMatchObject({ name: "orders.fifo", fifo: true });
  });

  test("discovers cron() markers in a plain .js file (allowJs)", () => {
    const dir = makeProject({
      "src/jobs.js": `
        import { cron, rate } from "@alzulejos/laranja-decorators";
        export async function refreshCache() {
          return { refreshed: true };
        }
        cron(rate(10, "minutes"), refreshCache);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.crons).toHaveLength(1);
    expect(ir.crons[0]).toMatchObject({
      style: "function",
      exportName: "refreshCache",
      schedule: { kind: "rate", value: 10, unit: "minute" },
    });
  });

  test("discovers an http() marker and routes in a .js app", () => {
    const dir = makeProject({
      "src/app.js": `
        import express from "express";
        import { http } from "@alzulejos/laranja-decorators";
        const app = express();
        app.get("/health", (_req, res) => res.json({ ok: true }));
        export default http(app);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg() });
    expect(ir.http).toMatchObject({ handlerEntry: "src/app.js", appExport: "default" });
    expect(ir.http?.routes).toHaveLength(1);
  });

  test("resolves aliased imports", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron as schedule, rate } from "@alzulejos/laranja-decorators";
        export async function tick() {}
        schedule(rate(1, "hour"), tick);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.crons[0]).toMatchObject({ style: "function", exportName: "tick" });
  });

  test("rejects a handler that is not exported", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, rate } from "@alzulejos/laranja-decorators";
        async function notExported() {}
        cron(rate(5, "minutes"), notExported);
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg({ http: false }) })).toThrow(/must be exported/);
  });
});

describe("http app resolution", () => {
  test("a default-exported http() marker sets appExport to 'default'", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@alzulejos/laranja-decorators";
        const app = express();
        app.get("/", (_req, res) => res.json({ ok: true }));
        export default http(app);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg() });
    expect(ir.http).toMatchObject({ handlerEntry: "src/app.ts", appExport: "default" });
    expect(ir.http?.routes).toHaveLength(1);
  });

  test("a named-export http() marker uses that export name", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@alzulejos/laranja-decorators";
        export const api = http(express());
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg() });
    expect(ir.http?.appExport).toBe("api");
  });

  test("without an http() marker, an app alone is not deployed (no config fallback)", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        export const app = express();
        app.get("/health", (_req, res) => res.json({ ok: true }));
      `,
    });
    // The HTTP app is declared only by an http() marker — there is no
    // entry/appExport config fallback, so an unmarked app has nothing to deploy.
    expect(() => scan({ projectDir: dir, config: cfg() })).toThrow(/Nothing to deploy/);
  });

  test("http: false disables HTTP even with jobs present", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, rate } from "@alzulejos/laranja-decorators";
        export async function tick() {}
        cron(rate(1, "hour"), tick);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.http).toBeUndefined();
    expect(ir.crons).toHaveLength(1);
  });

  test("errors on more than one http() marker", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@alzulejos/laranja-decorators";
        export const a = http(express());
        export const b = http(express());
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg() })).toThrow(/only one HTTP app/);
  });

  test("errors when the http() marker is not exported", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@alzulejos/laranja-decorators";
        const app = http(express());
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg() })).toThrow(/must be exported/);
  });
});

describe("nothing to deploy", () => {
  test("throws when there is no app and no handlers", () => {
    const dir = makeProject({
      "src/empty.ts": `export const noop = 1;`,
    });
    expect(() => scan({ projectDir: dir, config: cfg({ http: false }) })).toThrow(/Nothing to deploy/);
  });
});

describe("compute config", () => {
  const jobs = {
    "src/jobs.ts": `
      import { Cron, every } from "@alzulejos/laranja-decorators";
      export class Jobs {
        @Cron({ schedule: every("day"), id: "cleanup" })
        async cleanup() {}
      }
    `,
  };

  test("applies global compute defaults to every resource", () => {
    const dir = makeProject(jobs);
    const ir = scan({
      projectDir: dir,
      config: cfg({ http: false, compute: { memory: 256, timeout: 30 } }),
    });
    expect(ir.crons[0].compute).toEqual({ memory: 256, timeout: 30 });
  });

  test("a per-resource override wins field by field over the global default", () => {
    const dir = makeProject(jobs);
    const ir = scan({
      projectDir: dir,
      config: cfg({
        http: false,
        compute: { memory: 256, timeout: 30 },
        resources: { cleanup: { memory: 1024, architecture: "arm64" } },
      }),
    });
    // memory overridden, timeout inherited, architecture added
    expect(ir.crons[0].compute).toEqual({ memory: 1024, timeout: 30, architecture: "arm64" });
  });

  test("leaves compute undefined when nothing is configured", () => {
    const dir = makeProject(jobs);
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.crons[0].compute).toBeUndefined();
  });

  test("the http proxy is configured under the 'http' id", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@alzulejos/laranja-decorators";
        export default http(express());
      `,
    });
    const ir = scan({
      projectDir: dir,
      config: cfg({ resources: { http: { memory: 512 } } }),
    });
    expect(ir.http?.compute).toEqual({ memory: 512 });
  });

  test("throws on a resources key that matches no resource", () => {
    const dir = makeProject(jobs);
    expect(() =>
      scan({ projectDir: dir, config: cfg({ http: false, resources: { cleanp: { memory: 512 } } }) }),
    ).toThrow(/resources\["cleanp"\] doesn't match any resource. Known ids: cleanup/);
  });
});

describe("queue & cron config", () => {
  // Two queues (the second doubles as a DLQ target) + one cron. Function-style so
  // ids are the export names: "process", "onDead", "reconcile".
  const makeJobs = () =>
    makeProject({
      "src/jobs.ts": `
        import { cron, queue, rate } from "@alzulejos/laranja-decorators";
        export async function process() {}
        export async function onDead() {}
        export async function reconcile() {}
        queue({ name: "orders" }, process);
        queue({ name: "orders-dead" }, onDead);
        cron(rate(1, "hour"), reconcile);
      `,
    });

  test("applies queue knobs and resolves a DLQ reference by id", () => {
    const ir = scan({
      projectDir: makeJobs(),
      config: cfg({
        http: false,
        resources: {
          // keyed by queue NAME, and the DLQ references another queue by name
          orders: {
            visibilityTimeout: 60,
            maxBatchingWindow: 5,
            reportBatchItemFailures: true,
            messageRetention: 1209600,
            dlq: { maxReceiveCount: 3, queue: "orders-dead" },
          },
        },
      }),
    });
    expect(ir.queues.find((q) => q.id === "process")).toMatchObject({
      visibilityTimeout: 60,
      maxBatchingWindow: 5,
      reportBatchItemFailures: true,
      messageRetention: 1209600,
      dlq: { maxReceiveCount: 3, queue: "orders-dead" },
    });
  });

  test("applies cron knobs and resolves a DLQ reference by id", () => {
    const ir = scan({
      projectDir: makeJobs(),
      config: cfg({
        http: false,
        resources: {
          reconcile: { timezone: "Europe/Berlin", retryAttempts: 2, maxEventAge: 3600, dlq: { queue: "orders-dead" } },
        },
      }),
    });
    expect(ir.crons.find((c) => c.id === "reconcile")).toMatchObject({
      timezone: "Europe/Berlin",
      retryAttempts: 2,
      maxEventAge: 3600,
      dlq: { queue: "orders-dead" },
    });
  });

  const expectThrow = (resources: Record<string, unknown>, re: RegExp) =>
    expect(() => scan({ projectDir: makeJobs(), config: cfg({ http: false, resources: resources as never }) })).toThrow(re);

  test("rejects a DLQ target that isn't a declared queue", () => {
    expectThrow({ orders: { dlq: { maxReceiveCount: 3, queue: "ghost" } } }, /is not a declared queue/);
  });

  test("rejects a DLQ that points at itself", () => {
    expectThrow({ orders: { dlq: { maxReceiveCount: 3, queue: "orders" } } }, /cannot be the queue itself/);
  });

  test("requires maxReceiveCount on a queue DLQ", () => {
    expectThrow({ orders: { dlq: { queue: "orders-dead" } } }, /requires maxReceiveCount/);
  });

  test("rejects visibilityTimeout below the consumer timeout", () => {
    expect(() =>
      scan({
        projectDir: makeJobs(),
        config: cfg({ http: false, compute: { timeout: 60 }, resources: { orders: { visibilityTimeout: 30 } } }),
      }),
    ).toThrow(/must be >= the consumer timeout/);
  });

  test("rejects contentBasedDedup on a non-FIFO queue", () => {
    expectThrow({ orders: { contentBasedDedup: true } }, /FIFO-only/);
  });

  test("rejects retryAttempts outside 0–2", () => {
    expectThrow({ reconcile: { retryAttempts: 5 } }, /between 0 and 2/);
  });

  test("rejects a cron-only knob on a queue", () => {
    expectThrow({ orders: { timezone: "UTC" } }, /timezone is not valid for a queue/);
  });

  test("rejects a queue-only knob on a cron", () => {
    expectThrow({ reconcile: { visibilityTimeout: 60 } }, /visibilityTimeout is not valid for a cron/);
  });

  test("rejects two queues that share a name", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { queue } from "@alzulejos/laranja-decorators";
        export async function a() {}
        export async function b() {}
        queue({ name: "orders" }, a);
        queue({ name: "orders" }, b);
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg({ http: false }) })).toThrow(/must be unique/);
  });
});

describe("env() discovery", () => {
  test("collects env('LITERAL') names — deduped, sorted, location-independent", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, rate, env } from "@alzulejos/laranja-decorators";
        const region = env("AWS_REGION");
        export async function refreshCache() {
          // a call buried in a handler body still counts (pure source analysis)
          const url = env("DATABASE_URL");
          const dup = env("AWS_REGION");
          return { url, region, dup };
        }
        cron(rate(10, "minutes"), refreshCache);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.envKeys).toEqual(["AWS_REGION", "DATABASE_URL"]);
  });

  test("is alias-aware and ignores dynamic (non-literal) names", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, rate, env as readEnv } from "@alzulejos/laranja-decorators";
        const name = "DYNAMIC";
        export async function job() {
          const a = readEnv("STRIPE_KEY");
          const b = readEnv(name);          // dynamic — intentionally skipped
          return { a, b };
        }
        cron(rate(1, "hour"), job);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.envKeys).toEqual(["STRIPE_KEY"]);
  });

  test("ignores an env() that isn't laranja's helper", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, rate } from "@alzulejos/laranja-decorators";
        function env(_n: string) { return ""; } // local shadow, not the helper
        export async function job() {
          return env("NOT_LARANJA");
        }
        cron(rate(1, "hour"), job);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.envKeys).toEqual([]);
  });
});

describe("nest framework", () => {
  test("detects the http() marker and discovers routes from Nest controllers", () => {
    const dir = makeProject({
      "src/main.ts": `
        import { http } from "@alzulejos/laranja-decorators";
        export async function bootstrap() { return {} as any; }
        export default http(bootstrap);
      `,
      "src/app.controller.ts": `
        import { Controller, Get } from "@nestjs/common";
        @Controller()
        export class AppController {
          @Get() getHello() { return "hi"; }
        }
      `,
      "src/users.controller.ts": `
        import { Controller, Get, Post } from "@nestjs/common";
        @Controller("users")
        export class UsersController {
          @Get() findAll() {}
          @Get(":id") findOne() {}
          @Post() create() {}
        }
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ framework: "nest" }) });

    expect(ir.app.framework).toBe("nest");
    expect(ir.http).toBeDefined();
    expect(ir.http).toMatchObject({ handlerEntry: "src/main.ts", appExport: "default" });

    const routes = ir.http!.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(routes).toEqual(["GET /", "GET /users", "GET /users/:id", "POST /users"].sort());
  });

  test("does not treat a plain Express app.get() as a Nest route", () => {
    const dir = makeProject({
      "src/main.ts": `
        import { http } from "@alzulejos/laranja-decorators";
        export async function bootstrap() { return {} as any; }
        export default http(bootstrap);
      `,
      // No @Controller here — an express-style call must be ignored under nest.
      "src/other.ts": `
        const app: any = {};
        app.get("/legacy", () => {});
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ framework: "nest" }) });
    expect(ir.http!.routes).toEqual([]);
  });
});

describe("Nest-style @Cron / @Interval (swap-the-import compatibility)", () => {
  test("translates a bare node-cron string to an AWS cron schedule", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron("0 12 * * *")
          async noon() {}
        }
      `,
      "src/app.module.ts": `
        import { workers } from "@alzulejos/laranja-decorators";
        class AppModule {}
        export default workers(AppModule);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false, framework: "nest" }) });
    expect(ir.crons[0].schedule).toEqual({ kind: "cron", expression: "0 12 * * ? *", dialect: "aws" });
  });

  test("folds CronExpression.* members", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, CronExpression } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron(CronExpression.EVERY_5_MINUTES)
          async tick() {}
        }
      `,
      "src/app.module.ts": `
        import { workers } from "@alzulejos/laranja-decorators";
        class AppModule {}
        export default workers(AppModule);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false, framework: "nest" }) });
    expect(ir.crons[0].schedule).toEqual({ kind: "cron", expression: "*/5 * * * ? *", dialect: "aws" });
  });

  test("reads Nest's second-arg options (name -> id, timeZone -> timezone)", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron("0 3 * * *", { name: "nightly", timeZone: "Europe/Lisbon" })
          async run() {}
        }
      `,
      "src/app.module.ts": `
        import { workers } from "@alzulejos/laranja-decorators";
        class AppModule {}
        export default workers(AppModule);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false, framework: "nest" }) });
    expect(ir.crons[0]).toMatchObject({ id: "nightly", timezone: "Europe/Lisbon" });
  });

  test("@Interval(ms) becomes a rate schedule", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Interval } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Interval(300000)
          async poll() {}
        }
      `,
      "src/app.module.ts": `
        import { workers } from "@alzulejos/laranja-decorators";
        class AppModule {}
        export default workers(AppModule);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false, framework: "nest" }) });
    expect(ir.crons[0].schedule).toEqual({ kind: "rate", value: 5, unit: "minute" });
  });

  test("rejects sub-minute schedules loudly", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, CronExpression } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron(CronExpression.EVERY_30_SECONDS)
          async tooOften() {}
        }
      `,
      "src/app.module.ts": `
        import { workers } from "@alzulejos/laranja-decorators";
        class AppModule {}
        export default workers(AppModule);
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg({ http: false, framework: "nest" }) })).toThrow(/sub-minute/);
  });

  test("rejects @Timeout with a clear message", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Timeout } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Timeout(5000)
          async once() {}
        }
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg({ http: false, framework: "nest" }) })).toThrow(/no serverless equivalent/);
  });
});

describe("multi-root workers (per-module DI graphs)", () => {
  // A two-root project: a queues module and a crons module, each with its own
  // provider, so each worker Lambda boots only its own DI graph.
  const twoRoots = () => ({
    "src/queue/email.consumer.ts": `
      import { Queue } from "@alzulejos/laranja-decorators";
      export class EmailConsumer {
        @Queue({ name: "emails" })
        async handle() {}
      }
    `,
    "src/queue/queue.module.ts": `
      import { Module } from "@nestjs/common";
      import { workers } from "@alzulejos/laranja-decorators";
      import { EmailConsumer } from "./email.consumer";
      @Module({ providers: [EmailConsumer] })
      class QueueModule {}
      export default workers(QueueModule);
    `,
    "src/cron/sweep.service.ts": `
      import { Cron, rate } from "@alzulejos/laranja-decorators";
      export class SweepService {
        @Cron(rate(5, "minutes"))
        async sweep() {}
      }
    `,
    "src/cron/cron.module.ts": `
      import { Module } from "@nestjs/common";
      import { workers } from "@alzulejos/laranja-decorators";
      import { SweepService } from "./sweep.service";
      @Module({ providers: [SweepService] })
      class CronModule {}
      export default workers(CronModule);
    `,
  });

  test("binds each handler to the module that owns its provider", () => {
    const ir = scan({ projectDir: makeProject(twoRoots()), config: cfg({ framework: "nest" }) });

    expect(ir.workers).toHaveLength(2);
    expect(ir.workers?.map((w) => w.id).sort()).toEqual(["CronModule", "QueueModule"]);
    expect(ir.queues[0]).toMatchObject({ className: "EmailConsumer", workersId: "QueueModule" });
    expect(ir.crons[0]).toMatchObject({ className: "SweepService", workersId: "CronModule" });
  });

  test("resolves providers transitively through a module's imports", () => {
    const dir = makeProject({
      "src/mail/email.consumer.ts": `
        import { Queue } from "@alzulejos/laranja-decorators";
        export class EmailConsumer {
          @Queue({ name: "emails" })
          async handle() {}
        }
      `,
      "src/mail/mail.module.ts": `
        import { Module } from "@nestjs/common";
        import { EmailConsumer } from "./email.consumer";
        @Module({ providers: [EmailConsumer] })
        export class MailModule {}
      `,
      "src/queue/queue.module.ts": `
        import { Module } from "@nestjs/common";
        import { workers } from "@alzulejos/laranja-decorators";
        import { MailModule } from "../mail/mail.module";
        @Module({ imports: [MailModule] })
        class QueueModule {}
        export default workers(QueueModule);
      `,
      "src/cron/sweep.service.ts": `
        import { Cron, rate } from "@alzulejos/laranja-decorators";
        export class SweepService {
          @Cron(rate(5, "minutes"))
          async sweep() {}
        }
      `,
      "src/cron/cron.module.ts": `
        import { Module } from "@nestjs/common";
        import { workers } from "@alzulejos/laranja-decorators";
        import { SweepService } from "./sweep.service";
        @Module({ providers: [SweepService] })
        class CronModule {}
        export default workers(CronModule);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ framework: "nest" }) });
    expect(ir.queues[0]).toMatchObject({ className: "EmailConsumer", workersId: "QueueModule" });
  });

  test("errors when a handler's provider is in no workers module", () => {
    const files = twoRoots();
    // Orphan the consumer: drop it from QueueModule's providers.
    files["src/queue/queue.module.ts"] = files["src/queue/queue.module.ts"].replace(
      "providers: [EmailConsumer]",
      "providers: []",
    );
    expect(() => scan({ projectDir: makeProject(files), config: cfg({ framework: "nest" }) })).toThrow(
      /EmailConsumer\.handle isn't a provider in any workers\(\) module/,
    );
  });

  test("errors when a workers module owns no @Cron/@Queue provider", () => {
    const files = twoRoots();
    // CronModule now provides a plain service with no worker decorators.
    files["src/cron/sweep.service.ts"] = `export class SweepService { async sweep() {} }`;
    expect(() => scan({ projectDir: makeProject(files), config: cfg({ framework: "nest" }) })).toThrow(
      /workers\(CronModule\).*owns no @Cron\/@Queue provider/,
    );
  });

  test("errors when a provider belongs to two workers modules", () => {
    const files = twoRoots();
    // Put EmailConsumer in CronModule too — ambiguous DI root.
    files["src/cron/cron.module.ts"] = files["src/cron/cron.module.ts"]
      .replace(
        'import { SweepService } from "./sweep.service";',
        'import { SweepService } from "./sweep.service";\n      import { EmailConsumer } from "../queue/email.consumer";',
      )
      .replace("providers: [SweepService]", "providers: [SweepService, EmailConsumer]");
    expect(() => scan({ projectDir: makeProject(files), config: cfg({ framework: "nest" }) })).toThrow(
      /EmailConsumer\.handle resolves to multiple workers\(\) modules/,
    );
  });

  test("a single workers root still binds every handler to it (no graph walk needed)", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, Queue, rate } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron(rate(5, "minutes"))
          async sweep() {}
          @Queue({ name: "emails" })
          async handle() {}
        }
      `,
      // A bare module with no @Module graph — the common simple case must keep working.
      "src/app.module.ts": `
        import { workers } from "@alzulejos/laranja-decorators";
        class AppModule {}
        export default workers(AppModule);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ framework: "nest" }) });
    expect(ir.workers).toEqual([{ id: "AppModule", handlerEntry: "src/app.module.ts", appExport: "default" }]);
    expect(ir.crons[0].workersId).toBe("AppModule");
    expect(ir.queues[0].workersId).toBe("AppModule");
  });
});
