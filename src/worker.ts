
import type { D1Database } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/proposals") {
      if (request.method !== "GET") {
        return Response.json(
          { success: false, error: "Method not allowed" },
          { status: 405 }
        );
      }

      try {
        const { results } = await env.DB.prepare(`
          SELECT
            id,
            title,
            description,
            snapshot_block,
            start_time,
            end_time,
            status
          FROM proposals
          WHERE status IN ('open', 'closed')
          ORDER BY id DESC
          LIMIT 50
        `).all();

        return Response.json({
          success: true,
          proposals: results
        });
      } catch (error) {
        console.error("Database error:", error);

        return Response.json(
          {
            success: false,
            error: "Unable to load proposals"
          },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};

