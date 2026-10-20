
import { useEffect, useState } from "react";
import { recoverMessageAddress } from "viem";
import { ADMIN_WALLET } from "./admin";

type EthereumProvider = {
  request: (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type Proposal = {
  id: number;
  title: string;
  description: string | null;
  status: string;
  start_time: string;
  end_time: string;
};

type ProposalListResponse = {
  success: boolean;
  proposals?: Proposal[];
  error?: string;
};

function toHex(message: string): `0x${string}` {
  return `0x${Array.from(
    new TextEncoder().encode(message),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

export default function Admin() {
  const [wallet, setWallet] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [durationHours, setDurationHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loadingProposals, setLoadingProposals] = useState(true);
  const [proposalError, setProposalError] = useState("");

  const isAdmin =
    wallet.toLowerCase() === ADMIN_WALLET.toLowerCase();

  async function loadProposals() {
    try {
      const response = await fetch("/api/proposals", {
        cache: "no-store"
      });

      const data =
        (await response.json()) as ProposalListResponse;

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Unable to load proposals."
        );
      }

      setProposals(data.proposals || []);
      setProposalError("");
    } catch (error) {
      setProposalError(
        error instanceof Error
          ? error.message
          : "Unable to load proposals."
      );
    } finally {
      setLoadingProposals(false);
    }
  }

  useEffect(() => {
    void loadProposals();
  }, []);

  async function connectWallet() {
    setMessage("");

    try {
      if (!window.ethereum) {
        throw new Error(
          "Please install or open a crypto wallet."
        );
      }

      const accounts =
        (await window.ethereum.request({
          method: "eth_requestAccounts"
        })) as string[];

      const address = accounts[0];

      if (!address) {
        throw new Error("No wallet connected.");
      }

      setWallet(address);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Connection failed."
      );
    }
  }

  async function getAdminSigner(): Promise<string> {
    if (!window.ethereum) {
      throw new Error("No crypto wallet detected.");
    }

    const accounts =
      (await window.ethereum.request({
        method: "eth_accounts"
      })) as string[];

    const signingWallet = accounts[0];

    if (
      !signingWallet ||
      signingWallet.toLowerCase() !==
        ADMIN_WALLET.toLowerCase()
    ) {
      throw new Error(
        "Connect the authorized administrator wallet."
      );
    }

    return signingWallet;
  }

  async function signAdminMessage(
    message: string,
    signingWallet: string
  ): Promise<`0x${string}`> {
    if (!window.ethereum) {
      throw new Error("No crypto wallet detected.");
    }

    const signature =
      (await window.ethereum.request({
        method: "personal_sign",
        params: [
          toHex(message),
          signingWallet
        ]
      })) as `0x${string}`;

    const recoveredAddress =
      await recoverMessageAddress({
        message,
        signature
      });

    if (
      recoveredAddress.toLowerCase() !==
        ADMIN_WALLET.toLowerCase()
    ) {
      throw new Error(
        "Wallet signature verification failed."
      );
    }

    return signature;
  }

  async function publishProposal() {
    if (!isAdmin) {
      setMessage("Administrator wallet required.");
      return;
    }

    if (
      !title.trim() ||
      title.length > 200 ||
      description.length > 2000 ||
      options.length < 2 ||
      options.length > 10 ||
      options.some(
        (option) =>
          !option.trim() || option.length > 200
      )
    ) {
      setMessage(
        "Please complete all proposal fields."
      );
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const signingWallet = await getAdminSigner();

      const proposal = {
        action: "CREATE_PARLAY_PROPOSAL",
        origin: window.location.origin,
        title,
        description,
        options,
        durationHours,
        nonce: crypto.randomUUID(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };

      const signedMessage = JSON.stringify(proposal);

      const signature = await signAdminMessage(
        signedMessage,
        signingWallet
      );

      const response = await fetch(
        "/api/proposals",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            title: proposal.title,
            description: proposal.description,
            options: proposal.options,
            durationHours: proposal.durationHours,
            nonce: proposal.nonce,
            expiresAt: proposal.expiresAt,
            signature
          })
        }
      );

      const result =
        (await response.json()) as {
          success: boolean;
          proposalId?: number;
          error?: string;
        };

      if (!response.ok || !result.success) {
        throw new Error(
          result.error ||
          "Unable to publish proposal."
        );
      }

      setMessage(
        `Proposal #${result.proposalId} published successfully!`
      );

      setTitle("");
      setDescription("");
      setOptions(["", ""]);

      await loadProposals();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Publishing failed."
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteProposal(
    proposal: Proposal
  ) {
    if (!isAdmin || busy) {
      return;
    }

    const confirmed = window.confirm(
      `Delete proposal #${proposal.id}?\n\n` +
      `${proposal.title}\n\n` +
      "This will remove it from the public website. " +
      "The database record will be archived for accountability."
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const signingWallet = await getAdminSigner();

      const authorization = {
        action: "DELETE_PARLAY_PROPOSAL",
        origin: window.location.origin,
        proposalId: proposal.id,
        nonce: crypto.randomUUID(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };

      const signedMessage =
        JSON.stringify(authorization);

      const signature =
        await signAdminMessage(
          signedMessage,
          signingWallet
        );

      const response = await fetch(
        `/api/proposals/${proposal.id}`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            proposalId: authorization.proposalId,
            nonce: authorization.nonce,
            expiresAt: authorization.expiresAt,
            signature
          })
        }
      );

      const result =
        (await response.json()) as {
          success: boolean;
          error?: string;
        };

      if (!response.ok || !result.success) {
        throw new Error(
          result.error ||
          "Unable to delete proposal."
        );
      }

      setMessage(
        `Proposal #${proposal.id} deleted successfully.`
      );

      await loadProposals();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to delete proposal."
      );
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle = {
    width: "100%",
    padding: 12,
    borderRadius: 8,
    boxSizing: "border-box" as const,
    color: "#ffffff",
    background: "#075d36",
    border: "1px solid #e6bb53"
  };

  const goldButton = {
    padding: 16,
    background: "#e6bb53",
    color: "#ffffff",
    fontWeight: "bold" as const,
    border: 0,
    borderRadius: 10,
    cursor: "pointer"
  };

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "40px auto",
        padding: 24,
        color: "#ffffff",
        background: "#087c45",
        borderRadius: 18
      }}
    >
      <h1 style={{ color: "#ffe19a" }}>
        PARLAY ADMIN
      </h1>

      <p>
        Create and manage community voting proposals.
      </p>

      {!wallet ? (
        <button
          onClick={connectWallet}
          style={goldButton}
        >
          Connect Administrator Wallet
        </button>
      ) : (
        <p>
          Connected: {wallet.slice(0, 6)}...
          {wallet.slice(-4)}
        </p>
      )}

      {wallet && !isAdmin && (
        <p style={{ color: "#ffe19a" }}>
          This wallet is not authorized to manage proposals.
        </p>
      )}

      {isAdmin && (
        <>
          <div
            style={{
              display: "grid",
              gap: 14
            }}
          >
            <h2 style={{ color: "#ffe19a" }}>
              Create Proposal
            </h2>

            <label>
              Proposal Title
              <input
                value={title}
                maxLength={200}
                onChange={(event) =>
                  setTitle(event.target.value)
                }
                placeholder="Which parlay should we play?"
                style={fieldStyle}
              />
            </label>

            <label>
              Description
              <textarea
                value={description}
                maxLength={2000}
                onChange={(event) =>
                  setDescription(event.target.value)
                }
                placeholder="Describe the proposed wager."
                style={fieldStyle}
              />
            </label>

            <h3 style={{ color: "#ffe19a" }}>
              Voting Options
            </h3>

            {options.map((option, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  gap: 8
                }}
              >
                <input
                  value={option}
                  maxLength={200}
                  placeholder={`Option ${index + 1}`}
                  onChange={(event) =>
                    setOptions((previous) =>
                      previous.map((value, i) =>
                        i === index
                          ? event.target.value
                          : value
                      )
                    )
                  }
                  style={{
                    ...fieldStyle,
                    flex: 1,
                    minWidth: 0
                  }}
                />

                <button
                  disabled={options.length <= 2}
                  onClick={() =>
                    setOptions((previous) =>
                      previous.filter(
                        (_, i) => i !== index
                      )
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}

            <button
              disabled={options.length >= 10}
              onClick={() =>
                setOptions((previous) => [
                  ...previous,
                  ""
                ])
              }
            >
              + Add Voting Option
            </button>

            <label>
              Voting Duration
              <select
                value={durationHours}
                onChange={(event) =>
                  setDurationHours(
                    Number(event.target.value)
                  )
                }
                style={fieldStyle}
              >
                <option value={1 / 12}>5 minutes (TEST ONLY)</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
                <option value={72}>72 hours</option>
              </select>
            </label>

            <button
              disabled={busy}
              onClick={publishProposal}
              style={goldButton}
            >
              {busy
                ? "Waiting for Wallet..."
                : "SIGN & PUBLISH PROPOSAL"}
            </button>
          </div>

          <hr
            style={{
              border: 0,
              borderTop: "1px solid #e6bb53",
              margin: "36px 0"
            }}
          />

          <section>
            <h2 style={{ color: "#ffe19a" }}>
              Manage Published Proposals
            </h2>

            {loadingProposals && (
              <p>Loading proposals...</p>
            )}

            {proposalError && (
              <p role="alert">
                {proposalError}
              </p>
            )}

            {!loadingProposals &&
              !proposalError &&
              proposals.length === 0 && (
                <p>No published proposals found.</p>
              )}

            {proposals.map((proposal) => (
              <div
                key={proposal.id}
                style={{
                  border: "1px solid #e6bb53",
                  borderRadius: 12,
                  padding: 16,
                  marginBottom: 14,
                  background: "#075d36"
                }}
              >
                <p
                  style={{
                    color: "#ffe19a",
                    fontWeight: "bold"
                  }}
                >
                  PROPOSAL #{String(
                    proposal.id
                  ).padStart(3, "0")}
                </p>

                <h3>{proposal.title}</h3>

                <p>
                  Status: {proposal.status.toUpperCase()}
                </p>

                <p>
                  <small>
                    Closes:{" "}
                    {new Date(
                      proposal.end_time
                    ).toLocaleString()}
                  </small>
                </p>

                <button
                  disabled={busy}
                  onClick={() =>
                    void deleteProposal(proposal)
                  }
                  style={{
                    ...goldButton,
                    background: "#a52a2a",
                    border: "1px solid #ffe19a"
                  }}
                >
                  DELETE PROPOSAL
                </button>
              </div>
            ))}

            <button
              disabled={busy}
              onClick={() =>
                void loadProposals()
              }
              style={{
                ...goldButton,
                marginTop: 8
              }}
            >
              Refresh Proposal List
            </button>
          </section>
        </>
      )}

      {message && (
        <p
          role="status"
          style={{
            marginTop: 20,
            color: "#ffe19a"
          }}
        >
          {message}
        </p>
      )}
    </main>
  );
}
