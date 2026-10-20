
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

const json = (data: unknown, status = 200) =>
  Response.json(data, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // PUBLIC: Read proposals
    if (
      url.pathname === "/api/proposals" &&
      request.method === "GET"
    ) {
      try {
        const { results } = await env.DB.prepare(`
          SELECT id, title, description,
                 snapshot_block, start_time,
                 end_time, status
          FROM proposals
          WHERE status IN ('open', 'closed')
          ORDER BY id DESC
          LIMIT 50
        `).all();

        return json({ success: true, proposals: results });
      } catch (error) {
        console.error(error);
        return json({ success: false, error: "Database error" }, 500);
      }
    }

    // ADMIN ONLY: Create a proposal
    if (
      url.pathname === "/api/proposals" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json() as ProposalRequest;

        if (
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
          typeof body.nonce !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(body.nonce) ||
          !Number.isSafeInteger(body.expiresAt) ||
          typeof body.signature !== "string" ||
          !/^0x[0-9a-f]{130}$/i.test(body.signature)
        ) {
          return json(
            { success: false, error: "Invalid proposal data" },
            400
          );
        }

        const now = Date.now();

        if (
          body.expiresAt <= now ||
          body.expiresAt > now + 5 * 60 * 1000
        ) {
          return json(
            { success: false, error: "Authorization expired" },
            401
          );
        }

        // The signed message includes the exact proposal,
        // website origin, nonce and expiration.
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

        const signer = await recoverMessageAddress({
          message,
          signature: body.signature
        });

        if (
          !isAddress(signer) ||
          signer.toLowerCase() !== ADMIN_WALLET.toLowerCase()
        ) {
          return json(
            { success: false, error: "Not authorized" },
            403
          );
        }

        // Reserve the nonce before creating the proposal.
        // D1's unique constraint prevents replay.
        await env.DB.prepare(`
          INSERT INTO admin_nonces (nonce, expires_at)
          VALUES (?, ?)
        `).bind(body.nonce, body.expiresAt).run();

        const snapshotResponse = await fetch(
          "https://rpc.mainnet.chain.robinhood.com",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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

        const snapshotData = await snapshotResponse.json() as {
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

        const proposal = await env.DB.prepare(`
          INSERT INTO proposals (
            title, description, snapshot_block,
            start_time, end_time, status
          )
          VALUES (?, ?, ?, ?, ?, 'open')
          RETURNING id
        `).bind(
          body.title.trim(),
          body.description.trim(),
          BigInt(snapshotData.result).toString(),
          startTime,
          endTime
        ).first<{ id: number }>();

        if (!proposal) {
          throw new Error("Proposal creation failed");
        }

        for (const option of body.options) {
          await env.DB.prepare(`
            INSERT INTO proposal_options (
              proposal_id, title
            )
            VALUES (?, ?)
          `).bind(proposal.id, option.trim()).run();
        }

        return json({
          success: true,
          proposalId: proposal.id
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
      return json(
        { success: false, error: "API endpoint not found" },
        404
      );
    }

    return env.ASSETS.fetch(request);
  }
};
