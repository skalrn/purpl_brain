import "dotenv/config";

const DEV_DEFAULTS: Record<string, string> = {
  SESSION_SECRET: "purpl-brain-dev-secret-change-in-production",
  NEO4J_PASSWORD: "password",
  NEO4J_PASS: "password",
};

/**
 * Validate required env vars at startup.
 * SESSION_SECRET must always be set and must not be the dev default — session
 * hijacking is possible with a known secret regardless of environment.
 * NEO4J_URI/NEO4J_USER and other infra vars warn in dev, fail hard in prod.
 */
export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === "production";

  // Always required, always fails hard (not just in prod)
  const alwaysRequired = [
    "SESSION_SECRET",
  ];

  // Required in prod, warn in dev
  const required = [
    "NEO4J_URI",
    "NEO4J_USER",
  ];

  // Must not be default value — always enforced
  const mustNotBeDefault = [
    "SESSION_SECRET",
    "NEO4J_PASSWORD",
  ];

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of alwaysRequired) {
    if (!process.env[key]) {
      errors.push(`${key} is not set`);
    }
  }

  for (const key of required) {
    if (!process.env[key]) {
      (isProd ? errors : warnings).push(`${key} is not set`);
    }
  }

  for (const key of mustNotBeDefault) {
    const val = process.env[key] ?? process.env[key.replace("PASSWORD", "PASS")];
    if (val && DEV_DEFAULTS[key] && val === DEV_DEFAULTS[key]) {
      errors.push(`${key} is using the insecure dev default — run setup.sh to generate real credentials`);
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
