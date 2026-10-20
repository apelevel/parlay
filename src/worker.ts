
import type { D1Database } from "@cloudflare/workers-types";
import { recoverMessageAddress, isAddress } from "viem";
import { ADMIN_WALLET } from "./admin";

interface Env {
  DB: D1Database;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

interface ProposalRequest {
  title: string;
  description: string;
  options: string[];
  durationHours: number;
  nonce: string;
  expiresAt: number;
  signature: `0x${string}`;
}

interface DeleteRequest {
  proposalId: number;
  nonce: string;
  expiresAt: number;
  signature: `0x${string}`;
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status });

function validAuthorization(body: {
  nonce: unknown;
  expiresAt: unknown;
  signature: unknown;
}): boolean {
  return (
    typeof body.nonce === "string" &&
    /^[0-9a-f-]{36}$/i.test(body.nonce) &&
    typeof body.expiresAt === "number" &&
    Number.isSafeInteger(body.expiresAt) &&
    typeof body.signature === "string" &&
    /^0x[0-9a-f]{130}$/i.test(body.signature)
  );
}

async function verifyAdminSignature(
  message: string,
  signature: `0x${string}`
): Promise<boolean> {
  const signer = await recoverMessageAddress({
    message,
    signature
  });

  return (
    isAddress(signer) &&
    signer.toLowerCase() === ADMIN_WALLET.toLowerCase()
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // PUBLIC: Read published proposals and voting options.
    if (
      url.pathname === "/api/proposals" &&
      request.method === "GET"
    ) {
      try {
        const { results: proposals } = await env.DB.prepare(`
          SELECT id, title, description,
                 snapshot_block, start_time,
                 end_time, status
          FROM proposals
          WHERE status IN ('open', 'closed')
          ORDER BY id DESC
          LIMIT 50
        `).all<{
          id: number;
          title: string;
          description: string | null;
          snapshot_block: string;
          start_time: string;
          end_time: string;
          status: string;
        }>();

        const ids = proposals.map((proposal) => proposal.id);

        if (ids.length === 0) {
          return json({
            success: true,
            proposals: []
          });
        }

        const placeholders = ids.map(() => "?").join(",");

        const { results: options } = await env.DB.prepare(`
          SELECT id, proposal_id, title, description
          FROM proposal_options
          WHERE proposal_id IN (${placeholders})
          ORDER BY id ASC
        `).bind(...ids).all<{
          id: number;
          proposal_id: number;
          title: string;
          description: string | null;
        }>();

        const data = proposals.map((proposal) => ({
          ...proposal,
          options: options.filter(
            (option) => option.proposal_id === proposal.id
          )
        }));

        return json({
          success: true,
          proposals: data
        });
      } catch (error) {
        console.error("Proposal listing error:", error);

        return json({
          success: false,
          error: "Database error"
        }, 500);
      }
    }

    // ADMIN ONLY: Archive a published proposal.
    const deleteMatch = url.pathname.match(
      /^\/api\/proposals\/([1-9]\d*)$/
    );

    if (
      deleteMatch &&
      request.method === "DELETE"
    ) {
      try {
        const proposalId = Number(deleteMatch[1]);

        if (!Number.isSafeInteger(proposalId)) {
          return json({
            success: false,
            error: "Invalid proposal ID"
          }, 400);
        }

        let body: DeleteRequest;

        try {
          body = await request.json() as DeleteRequest;
        } catch {
          return json({
            success: false,
            error: "Invalid request body"
          }, 400);
        }

        if (
          !body ||
          body.proposalId !== proposalId ||
          !validAuthorization(body)
        ) {
          return json({
            success: false,
            error: "Invalid deletion request"
          }, 400);
        }

        const now = Date.now();

        if (
          body.expiresAt <= now ||
          body.expiresAt > now + 5 * 60 * 1000
        ) {
          return json({
            success: false,
            error: "Authorization expired"
          }, 401);
        }

        // The signature is bound to this website and proposal.
        const message = JSON.stringify({
          action: "DELETE_PARLAY_PROPOSAL",
          origin: url.origin,
          proposalId,
          nonce: body.nonce,
          expiresAt: body.expiresAt
        });

        const authorized = await verifyAdminSignature(
          message,
          body.signature
        );

        if (!authorized) {
          return json({
            success: false,
            error: "Not authorized"
          }, 403);
        }

        // Check the proposal before consuming the signature.
        const proposal = await env.DB.prepare(`
          SELECT id, status
          FROM proposals
          WHERE id = ?
        `).bind(proposalId).first<{
          id: number;
          status: string;
        }>();

        if (!proposal) {
          return json({
            success: false,
            error: "Proposal not found"
          }, 404);
        }

        if (proposal.status === "archived") {
          return json({
            success: false,
            error: "Proposal already archived"
          }, 409);
        }

        // The nonce and archive operation execute atomically.
        // A reused nonce fails the unique database constraint.
        await env.DB.batch([
          env.DB.prepare(`
            INSERT INTO admin_nonces (
              nonce, expires_at
            )
            VALUES (?, ?)
          `).bind(
            body.nonce,
            body.expiresAt
          ),

          env.DB.prepare(`
            UPDATE proposals
            SET status = 'archived'
            WHERE id = ?
              AND status IN ('open', 'closed')
          `).bind(proposalId)
        ]);

        return json({
          success: true,
          proposalId,
          message: "Proposal archived successfully"
        });
      } catch (error) {
        console.error("Proposal deletion error:", error);

        return json({
          success: false,
          error: "Unable to archive proposal"
        }, 500);
      }
    }

    // ADMIN ONLY: Create a proposal.
    if (
      url.pathname === "/api/proposals" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json() as ProposalRequest;

        if (
          !body ||
          typeof body.title !== "string" ||
          !body.title.trim() ||
          body.title.length > 200 ||
          typeof body.description !== "string" ||
          body.description.length > 2000 ||
          !Array.isArray(body.options) ||
          body.options.length < 2 ||
          body.options.length > 10 ||
          !body.options.every(
            (option) =>
              typeof option === "string" &&
              option.trim().length > 0 &&
              option.length <= 200
          ) ||
          ![24, 48, 72].includes(body.durationHours) ||
          !validAuthorization(body)
        ) {
          return json({
            success: false,
            error: "Invalid proposal data"
          }, 400);
        }

        const now = Date.now();

        if (
          body.expiresAt <= now ||
          body.expiresAt > now + 5 * 60 * 1000
        ) {
          return json({
            success: false,
            error: "Authorization expired"
          }, 401);
        }

        const message = JSON.stringify({
          action: "CREATE_PARLAY_PROPOSAL",
          origin: url.origin,
          title: body.title,
          description: body.description,
          options: body.options,
          durationHours: body.durationHours,
          nonce: body.nonce,
          expiresAt: body.expiresAt
        });

        const authorized = await verifyAdminSignature(
          message,
          body.signature
        );

        if (!authorized) {
          return json({
            success: false,
            error: "Not authorized"
          }, 403);
        }

        // Retrieve the Robinhood Chain snapshot block.
        const snapshotResponse = await fetch(
          "https://rpc.mainnet.chain.robinhood.com",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_blockNumber",
              params: []
            })
          }
        );

        if (!snapshotResponse.ok) {
          throw new Error("Snapshot RPC unavailable");
        }

        const snapshotData =
          await snapshotResponse.json() as {
            result?: string;
          };

        if (
          !snapshotData.result ||
          !/^0x[0-9a-f]+$/i.test(snapshotData.result)
        ) {
          throw new Error("Invalid snapshot block");
        }

        const startTime = new Date(now).toISOString();

        const endTime = new Date(
          now + body.durationHours * 60 * 60 * 1000
        ).toISOString();

        // Save the nonce, proposal, and options together.
        // If any statement fails, D1 rolls back the batch.
        const statements = [
          env.DB.prepare(`
            INSERT INTO admin_nonces (
              nonce, expires_at
            )
            VALUES (?, ?)
          `).bind(
            body.nonce,
            body.expiresAt
          ),

          env.DB.prepare(`
            INSERT INTO proposals (
              title,
              description,
              snapshot_block,
              start_time,
              end_time,
              status
            )
            VALUES (?, ?, ?, ?, ?, 'open')
          `).bind(
            body.title.trim(),
            body.description.trim(),
            BigInt(snapshotData.result).toString(),
            startTime,
            endTime
          )
        ];

        // D1 last_insert_rowid() identifies the proposal inserted
        // by the preceding statement in the same batch.
        for (const option of body.options) {
          statements.push(
            env.DB.prepare(`
              INSERT INTO proposal_options (
                proposal_id,
                title
              )
              VALUES (
                last_insert_rowid(),
                ?
              )
            `).bind(option.trim())
          );
        }

        // Use an explicit proposal ID for option inserts instead.
        // The nonce and proposal are created first.
        const creation = await env.DB.batch(
          statements.slice(0, 2)
        );

        const proposalId = Number(
          creation[1].meta.last_row_id
        );

        if (
          !Number.isSafeInteger(proposalId) ||
          proposalId <= 0
        ) {
          throw new Error("Proposal ID unavailable");
        }

        const optionStatements = body.options.map(
          (option) =>
            env.DB.prepare(`
              INSERT INTO proposal_options (
                proposal_id,
                title
              )
              VALUES (?, ?)
            `).bind(
              proposalId,
              option.trim()
            )
        );

        await env.DB.batch(optionStatements);

        return json({
          success: true,
          proposalId
        }, 201);
      } catch (error) {
        console.error("Proposal creation error:", error);

        return json({
          success: false,
          error: "Unable to create proposal"
        }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({
        success: false,
        error: "API endpoint not found"
      }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
