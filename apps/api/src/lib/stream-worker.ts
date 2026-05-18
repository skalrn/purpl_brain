import { Redis } from "ioredis";

export interface WorkerConfig {
  name: string;
  stream: string;
  group: string;
  consumer: string;
  /** Field name extracted from each stream entry (e.g. "event", "result") */
  fieldName: string;
  blockMs?: number;
  batchSize?: number;
}

/**
 * Base class for Redis Streams consumer workers.
 * Handles: group creation, SIGTERM/SIGINT shutdown, pending-message drain
 * on startup, the main xreadgroup loop, and connection teardown.
 *
 * Subclasses implement:
 *   processMessage(id, value)  — called with the raw JSON string per message
 *   onShutdown()               — close extra connections (second Redis, Neo4j, etc.)
 */
export abstract class StreamWorker {
  protected readonly name: string;
  protected readonly stream: string;
  protected readonly group: string;
  protected readonly consumer: string;
  protected readonly fieldName: string;
  protected readonly blockMs: number;
  protected readonly batchSize: number;
  protected shuttingDown = false;

  protected constructor(
    protected readonly redis: Redis,
    config: WorkerConfig
  ) {
    this.name = config.name;
    this.stream = config.stream;
    this.group = config.group;
    this.consumer = config.consumer;
    this.fieldName = config.fieldName;
    this.blockMs = config.blockMs ?? 5000;
    this.batchSize = config.batchSize ?? 10;

    process.on("SIGTERM", () => {
      console.log(`[${this.name}] SIGTERM received, finishing current batch then exiting`);
      this.shuttingDown = true;
    });
    process.on("SIGINT", () => {
      console.log(`[${this.name}] SIGINT received, finishing current batch then exiting`);
      this.shuttingDown = true;
    });
  }

  protected abstract processMessage(id: string, value: string): Promise<void>;

  /** Override to close extra connections before process.exit(). */
  protected async onShutdown(): Promise<void> {}

  private async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", this.stream, this.group, "0", "MKSTREAM");
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes("BUSYGROUP")) throw e;
    }
  }

  private async drainPending(): Promise<void> {
    console.log(`[${this.name}] checking for pending messages...`);
    let recovered = 0;

    while (true) {
      const results = await this.redis.xreadgroup(
        "GROUP", this.group, this.consumer,
        "COUNT", this.batchSize,
        "STREAMS", this.stream, "0"
      );
      if (!results) break;
      const messages = (results as [string, [string, string[]][]][])[0]?.[1];
      if (!messages || messages.length === 0) break;

      for (const [id, fields] of messages) {
        const value = fields[fields.indexOf(this.fieldName) + 1];
        if (!value) {
          await this.redis.xack(this.stream, this.group, id);
          continue;
        }
        try {
          await this.processMessage(id, value);
          recovered++;
        } catch (e) {
          console.error(`[${this.name}] pending recovery failed for ${id}:`, e);
          await this.redis.xack(this.stream, this.group, id);
        }
      }
    }

    if (recovered > 0) {
      console.log(`[${this.name}] recovered ${recovered} pending message(s)`);
    }
  }

  async run(): Promise<void> {
    await this.ensureGroup();
    await this.drainPending();
    console.log(`[${this.name}] started, reading from`, this.stream);

    while (true) {
      if (this.shuttingDown) break;

      const results = await this.redis.xreadgroup(
        "GROUP", this.group, this.consumer,
        "COUNT", this.batchSize,
        "BLOCK", this.blockMs,
        "STREAMS", this.stream, ">"
      );
      if (!results) continue;

      for (const [, messages] of results as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          const value = fields[fields.indexOf(this.fieldName) + 1];
          if (!value) continue;
          try {
            await this.processMessage(id, value);
          } catch (e) {
            console.error(`[${this.name}] failed to process ${id}:`, e);
          }
        }
      }
    }

    console.log(`[${this.name}] draining connections...`);
    await this.onShutdown();
    await this.redis.quit().catch(() => undefined);
    console.log(`[${this.name}] exit`);
    process.exit(0);
  }
}
