/**
 * Auth routes — GitHub OAuth (M5)
 *
 * GET  /auth/github           — redirect to GitHub OAuth consent
 * GET  /auth/github/callback  — exchange code, upsert Person, set session
 * GET  /auth/me               — return current session user
 * POST /auth/logout           — clear session
 *
 * GitHub OAuth app setup (one-time, in your GitHub account):
 *   1. Go to: https://github.com/settings/developers → OAuth Apps → New OAuth App
 *   2. Application name: Purpl Brain
 *   3. Homepage URL: http://localhost:3000
 *   4. Authorization callback URL: http://localhost:3001/auth/github/callback
 *   5. Click "Register application"
 *   6. Copy Client ID → GITHUB_CLIENT_ID in .env
 *   7. Generate a client secret → GITHUB_CLIENT_SECRET in .env
 *   8. Set SESSION_SECRET to any random 32+ char string in .env
 */
import type { FastifyPluginAsync } from "fastify";
import fastifyOauth2, { type FastifyOAuth2Options } from "@fastify/oauth2";
import { v4 as uuidv4 } from "uuid";
import { upsertPersonByEmail, addPersonToProject } from "../lib/neo4j.js";

// Extend session type to carry the logged-in person
declare module "fastify" {
  interface Session {
    person_id?: string;
    email?: string;
    name?: string;
    github_login?: string;
    avatar_url?: string;
    api_key?: string;
  }
}

type _unused = FastifyOAuth2Options; // keep import used

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

async function getGitHubUser(token: string): Promise<GitHubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "purpl-brain" },
  });
  if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`);
  return res.json() as Promise<GitHubUser>;
}

async function getGitHubPrimaryEmail(token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "purpl-brain" },
  });
  if (!res.ok) return null;
  const emails = await res.json() as GitHubEmail[];
  const primary = emails.find((e) => e.primary && e.verified);
  return primary?.email ?? emails[0]?.email ?? null;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    app.log.warn(
      "GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET not set — auth routes disabled. " +
      "See apps/api/src/routes/auth.ts for OAuth app setup instructions."
    );
    // Register stub routes that return a clear error instead of 404
    app.get("/auth/github", async (_req, reply) =>
      reply.status(503).send({ error: "GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." })
    );
    app.get("/auth/github/callback", async (_req, reply) =>
      reply.status(503).send({ error: "GitHub OAuth not configured." })
    );
    app.get("/auth/me", async (_req, reply) =>
      reply.status(503).send({ error: "GitHub OAuth not configured." })
    );
    app.post("/auth/logout", async (_req, reply) =>
      reply.status(503).send({ error: "GitHub OAuth not configured." })
    );
    return;
  }

  await app.register(fastifyOauth2, {
    name: "githubOAuth2",
    scope: ["read:user", "user:email"],
    credentials: {
      client: { id: clientId, secret: clientSecret },
      auth: (fastifyOauth2 as unknown as { GITHUB_CONFIGURATION: unknown }).GITHUB_CONFIGURATION as fastifyOauth2.ProviderConfiguration,
    },
    startRedirectPath: "/auth/github",
    callbackUri: process.env.GITHUB_CALLBACK_URL ?? "http://localhost:3001/auth/github/callback",
  });

  // ── Callback — exchange code → GitHub user → upsert Person → session ──────
  app.get("/auth/github/callback", async (request, reply) => {
    try {
      // @ts-expect-error — fastify-oauth2 adds this dynamically
      const tokenResult = await app.githubOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);
      const token = tokenResult.token.access_token as string;

      const [ghUser, email] = await Promise.all([
        getGitHubUser(token),
        getGitHubPrimaryEmail(token),
      ]);

      const canonicalEmail = email ?? ghUser.email ?? `${ghUser.login}@github.noemail`;
      const apiKey = uuidv4();

      const person = await upsertPersonByEmail({
        email: canonicalEmail,
        name: ghUser.name ?? ghUser.login,
        github_login: ghUser.login,
        avatar_url: ghUser.avatar_url,
        api_key: apiKey,
      });

      // Grant membership on the default project for this brain deployment
      const defaultProjectId = process.env.DEFAULT_PROJECT_ID ?? "default";
      await addPersonToProject(person.person_id, defaultProjectId);

      // Store identity in session
      request.session.person_id = person.person_id;
      request.session.email = person.email;
      request.session.name = person.name;
      request.session.github_login = person.github_login;
      request.session.avatar_url = person.avatar_url;
      request.session.api_key = person.api_key;

      app.log.info({ github_login: ghUser.login, person_id: person.person_id }, "OAuth login");

      // Redirect to UI — in local dev this is :3000
      const uiBase = process.env.UI_BASE_URL ?? "http://localhost:3000";
      return reply.redirect(`${uiBase}?login=ok`);
    } catch (e) {
      app.log.error(e, "OAuth callback failed");
      return reply.status(500).send({ error: "OAuth login failed" });
    }
  });

  // ── GET /auth/me ──────────────────────────────────────────────────────────
  app.get("/auth/me", async (request, reply) => {
    const person_id = request.session.person_id;
    if (!person_id) return reply.status(401).send({ error: "Not authenticated" });

    return {
      person_id,
      email: request.session.email,
      name: request.session.name,
      github_login: request.session.github_login,
      avatar_url: request.session.avatar_url,
      api_key: request.session.api_key,
    };
  });

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  app.post("/auth/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.send({ ok: true });
  });
};
