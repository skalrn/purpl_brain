import "dotenv/config";

const DEV_DEFAULTS: Record<string, string> = {
  SESSION_SECRET: "purpl-brain-dev-secret-change-in-production",
  NEO4J_PASSWORD: "password",
  NEO4J_PASS: "password",
};

/**
 * Validate required env vars at startup. In production, missing or
 * default-value secrets cause a hard crash with a clear message.
 * In dev, they log a warning so local runs still work.
 */
export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === "production";

  const required = [
    "SESSION_SECRET",
    "NEO4J_URI",
    "NEO4J_USER",
  ];

  const mustNotBeDefault = [
    "SESSION_SECRET",
    "NEO4J_PASSWORD",
  ];

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      (isProd ? errors : warnings).push(`${key} is not set`);
    }
  }

  for (const key of mustNotBeDefault) {
    const val = process.env[key] ?? process.env[key.replace("PASSWORD", "PASS")];
    if (val && DEV_DEFAULTS[key] && val === DEV_DEFAULTS[key]) {
      (isProd ? errors : warnings).push(`${key} is using the insecure dev default`);
    }
  }

  for (const w of warnings) {
    console.warn(`[config] WARNING: ${w} — safe for local dev, not for production`);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`[config] FATAL: ${e}`);
    }
    console.error("[config] Set the required env vars before starting in production.");
    process.exit(1);
  }
}
