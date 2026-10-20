
import type { D1Database } from "@cloudflare/workers-types";
import {
  recoverMessageAddress,
  isAddress,
  getAddress
} from "viem";
import { ADMIN_WALLET } from "./admin";

interface Env {
  DB: D1Database;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

interface Authorization {
  nonce: string;
  expiresAt: number;
  signature: `0x${string}`;
}

interface ProposalRequest extends Authorization {
  title: string;
  description: string;
  options: string[];
  durationHours: number;
}

interface DeleteRequest extends Authorization {
  proposalId: number;
}

interface VoteRequest {
  proposalId: number;
  optionId: number;
  walletAddress: string;
  nonce: string;
  signature: `0x${string}`;
}

const RPC_URL =
  "https://rpc.mainnet.chain.robinhood.com";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status });

function validSignature(value: unknown): value is `0x${string}` {
  return (
    typeof value === "string" &&
    /^0x[0-9a-f]{130}$/i.test(value)
  );
}

function validNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function validAuthorization(
  body: Authorization
): boolean {
  return (
    validNonce(body.nonce) &&
    Number.isSafeInteger(body.expiresAt) &&
    validSignature(body.signature)
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

async function getCurrentBlock(): Promise<string> {
  const response = await fetch(RPC_URL, {
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
  });

  if (!response.ok) {
    throw new Error("Robinhood Chain RPC unavailable");
  }

  const data = await response.json() as {
    result?: string;
    error?: { message?: string };
  };

  if (
    !data.result ||
    !/^0x[0-9a-f]+$/i.test(data.result)
  ) {
    throw new Error(
      data.error?.message || "Invalid blockchain response"
    );
  }

  return BigInt(data.result).toString();
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url = new URL(request.url);

    // PUBLIC: List proposals and their voting options.
    if (
      url.pathname === "/api/proposals" &&
      request.method === "GET"
    ) {
      try {
        const { results: proposals } =
          await env.DB.prepare(`
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
          `).all<{
            id: number;
            title: string;
            description: string | null;
            snapshot_block: string;
            start_time: string;
            end_time: string;
            status: string;
          }>();

        if (proposals.length === 0) {
          return json({
            success: true,
            proposals: []
          });
        }

        const ids = proposals.map(
          (proposal) => proposal.id
        );

        const placeholders = ids
          .map(() => "?")
          .join(",");

        const { results: options } =
          await env.DB.prepare(`
            SELECT
              id,
              proposal_id,
              title,
              description
            FROM proposal_options
            WHERE proposal_id IN (${placeholders})
            ORDER BY id ASC
          `).bind(...ids).all<{
            id: number;
            proposal_id: number;
            title: string;
            description: string | null;
          }>();

        return json({
          success: true,
          proposals: proposals.map((proposal) => ({
            ...proposal,
            options: options.filter(
              (option) =>
                option.proposal_id === proposal.id
            )
          }))
        });
      } catch (error) {
        console.error("Proposal listing error:", error);

        return json({
          success: false,
          error: "Database error"
        }, 500);
      }
    }

    // PUBLIC: Submit a wallet-signed ballot.
    if (
      url.pathname === "/api/votes" &&
      request.method === "POST"
    ) {
      try {
        let body: VoteRequest;

        try {
          body = await request.json() as VoteRequest;
        } catch {
          return json({
            success: false,
            error: "Invalid request body"
          }, 400);
        }

        if (
          !body ||
          !Number.isSafeInteger(body.proposalId) ||
          body.proposalId <= 0 ||
          !Number.isSafeInteger(body.optionId) ||
          body.optionId <= 0 ||
          typeof body.walletAddress !== "string" ||
          !isAddress(body.walletAddress) ||
          !validNonce(body.nonce) ||
          !validSignature(body.signature)
        ) {
          return json({
            success: false,
            error: "Invalid ballot"
          }, 400);
        }

        const walletAddress = getAddress(
          body.walletAddress
        );

        // Verify the exact ballot that the voter signed.
        // The website origin prevents cross-site reuse.
        const signedMessage = JSON.stringify({
          action: "CAST_PARLAY_VOTE",
          origin: url.origin,
          chainId: 4663,
          token:
            "0xc4a481c39437680c54a2fdbe170d48a919ec98b7",
          proposalId: body.proposalId,
          optionId: body.optionId,
          walletAddress,
          nonce: body.nonce
        });

        const signer = await recoverMessageAddress({
          message: signedMessage,
          signature: body.signature
        });

        if (
          signer.toLowerCase() !==
          walletAddress.toLowerCase()
        ) {
          return json({
            success: false,
            error: "Wallet signature does not match"
          }, 403);
        }

        // Only currently open proposals accept ballots.
        const proposal = await env.DB.prepare(`
          SELECT id, status, start_time, end_time
          FROM proposals
          WHERE id = ?
        `).bind(body.proposalId).first<{
          id: number;
          status: string;
          start_time: string;
          end_time: string;
        }>();

        if (!proposal) {
          return json({
            success: false,
            error: "Proposal not found"
          }, 404);
        }

        const now = Date.now();
        const start = Date.parse(proposal.start_time);
        const end = Date.parse(proposal.end_time);

        if (
          proposal.status !== "open" ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          now < start ||
          now >= end
        ) {
          return json({
            success: false,
            error: "Voting is not open"
          }, 409);
        }

        // Ensure the selected option belongs to this proposal.
        const option = await env.DB.prepare(`
          SELECT id
          FROM proposal_options
          WHERE id = ?
            AND proposal_id = ?
        `).bind(
          body.optionId,
          body.proposalId
        ).first<{ id: number }>();

        if (!option) {
          return json({
            success: false,
            error: "Invalid voting option"
          }, 400);
        }

        // Store the ballot with zero *finalized* voting power.
        // The actual balance is calculated at closing.
        //
        // The INSERT ... SELECT rechecks the deadline
        // at database execution time.
        //
        // The votes table has a UNIQUE constraint on
        // (proposal_id, wallet_address), preventing
        // multiple ballots from the same wallet.
        const insert = await env.DB.prepare(`
          INSERT OR IGNORE INTO votes (
            proposal_id,
            option_id,
            wallet_address,
            voting_power,
            signature,
            signed_message
          )
          SELECT
            ?,
            ?,
            ?,
            '0',
            ?,
            ?
          WHERE EXISTS (
            SELECT 1
            FROM proposals
            WHERE id = ?
              AND status = 'open'
              AND julianday(start_time) <= julianday('now')
              AND julianday(end_time) > julianday('now')
          )
        `).bind(
          body.proposalId,
          body.optionId,
          walletAddress.toLowerCase(),
          body.signature,
          signedMessage,
          body.proposalId
        ).run();

        if (insert.meta.changes !== 1) {
          return json({
            success: false,
            error:
              "Ballot not accepted. You may have already voted, or voting has closed."
          }, 409);
        }

        return json({
          success: true,
          proposalId: body.proposalId,
          optionId: body.optionId,
          walletAddress,
          message:
            "Ballot recorded. Voting power will be determined at the closing snapshot."
        }, 201);
      } catch (error) {
        console.error("Vote submission error:", error);

        return json({
          success: false,
          error: "Unable to record ballot"
        }, 500);
      }
    }

    // ADMIN ONLY: Archive a proposal.
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

        if (
          proposal.status !== "open" &&
          proposal.status !== "closed"
        ) {
          return json({
            success: false,
            error: "Proposal cannot be archived"
          }, 409);
        }

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
        const body =
          await request.json() as ProposalRequest;

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

        const snapshotBlock = await getCurrentBlock();

        const startTime = new Date(now).toISOString();

        const endTime = new Date(
          now + body.durationHours * 60 * 60 * 1000
        ).toISOString();

        // Retain the creation flow used by the
        // existing administrator dashboard.
        const creation = await env.DB.batch([
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
            snapshotBlock,
            startTime,
            endTime
          )
        ]);

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
