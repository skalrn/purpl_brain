/**
 * Identity routes
 *
 * POST /brain/identity/link  — declare that multiple source identifiers belong
 *                              to the same person; merges any fragmented nodes
 * GET  /brain/people         — list all persons active in a project
 */
import type { FastifyPluginAsync } from "fastify";
import { requireApiKey, requireProjectMember } from "../lib/auth-middleware.js";
import { linkPersonIdentities, listPeopleInProject } from "../lib/neo4j.js";

export const identityRoutes: FastifyPluginAsync = async (fastify) => {

  // ── POST /brain/identity/link ────────────────────────────────────────────
  // At least one identifier is required. All fields are optional individually,
  // but together they must resolve to at least one existing node or create one.
  // project_id is required to scope the membership check — callers can only
  // link identities within projects they are members of.
  //
  // Example — Alice has three source identities that the brain sees separately:
  //   github_login: "alice-chen"
  //   slack_user_id: "U12345"
  //   jira_user_id: "alice.chen@company.com"
  //
  // One call merges all three into a single canonical Person node.
  fastify.post<{
    Body: {
      project_id: string;
      github_login?: string;
      slack_user_id?: string;
      jira_user_id?: string;
      email?: string;
      name?: string;
    };
  }>(
    "/brain/identity/link",
    { preHandler: [requireApiKey, requireProjectMember] },
    async (req, reply) => {
      const { project_id, github_login, slack_user_id, jira_user_id, email, name } = req.body;

      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }

      const identifiers = [github_login, slack_user_id, jira_user_id, email].filter(Boolean);
      if (identifiers.length === 0) {
        return reply.status(400).send({
          error: "At least one identifier required: github_login, slack_user_id, jira_user_id, or email",
        });
      }

      try {
        const result = await linkPersonIdentities({ github_login, slack_user_id, jira_user_id, email, name });
        return {
          ok: true,
          person_id: result.person_id,
          merged_count: result.merged_count,
          message: result.merged_count > 0
            ? `Merged ${result.merged_count} duplicate node(s) into canonical person ${result.person_id}`
            : `Identity updated for person ${result.person_id}`,
        };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to link identities" });
      }
    }
  );

  // ── GET /brain/people ────────────────────────────────────────────────────
  // Returns everyone who has authored at least one event in the project,
  // with their known source identifiers.
  // Provisional nodes (created from signals, not explicitly registered) are
  // flagged — these are candidates for identity linking.
  fastify.get<{ Querystring: { project_id: string } }>(
    "/brain/people",
    { preHandler: [requireApiKey, requireProjectMember] },
    async (req, reply) => {
      const { project_id } = req.query;

      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }

      try {
        const people = await listPeopleInProject(project_id);
        const provisional = people.filter((p) => p.provisional);
        return {
          people,
          total: people.length,
          provisional_count: provisional.length,
          hint: provisional.length > 0
            ? `${provisional.length} provisional identities need linking — POST /brain/identity/link to merge cross-source duplicates`
            : undefined,
        };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to list people" });
      }
    }
  );
};
