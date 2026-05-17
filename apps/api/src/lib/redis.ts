import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redis = new Redis(REDIS_URL);

export const STREAMS = {
  RAW: "events:raw",
  NORMALIZED: "events:normalized",
  EXTRACTED: "events:extracted",
  DRIFT: "events:drift",
} as const;

export const PROCESSED_SET = "processed:event_ids";
