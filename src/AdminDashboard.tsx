
import { useState } from "react";
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

export default function Admin() {
  const [wallet, setWallet] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [durationHours, setDurationHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const isAdmin =
    wallet.toLowerCase() === ADMIN_WALLET.toLowerCase();

  async function connectWallet() {
    setMessage("");

    try {
      if (!window.ethereum) {
        throw new Error("Please install or open a crypto wallet.");
      }

      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts"
      })) as string[];

      const address = accounts[0];

      if (!address) {
        throw new Error("No wallet connected.");
      }

      setWallet(address);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Connection failed."
      );
    }
  }

  async function publishProposal() {
    if (!window.ethereum || !isAdmin) {
      setMessage("Administrator wallet required.");
      return;
    }

    if (
      !title.trim() ||
      title.length > 200 ||
      description.length > 2000 ||
      options.length < 2 ||
      options.some(
        (option) => !option.trim() || option.length > 200
      )
    ) {
      setMessage("Please complete all proposal fields.");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const accounts = (await window.ethereum.request({
        method: "eth_accounts"
      })) as string[];

      const signingWallet = accounts[0];

      if (
        !signingWallet ||
        signingWallet.toLowerCase() !==
          ADMIN_WALLET.toLowerCase()
      ) {
        throw new Error("Connect the authorized administrator wallet.");
      }

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

      const signature = (await window.ethereum.request({
        method: "personal_sign",
        params: [
          `0x${Array.from(
            new TextEncoder().encode(signedMessage),
            (byte) => byte.toString(16).padStart(2, "0")
          ).join("")}`,
          signingWallet
        ]
      })) as `0x${string}`;

      const recoveredAddress = await recoverMessageAddress({
        message: signedMessage,
        signature
      });

      if (
        recoveredAddress.toLowerCase() !==
        ADMIN_WALLET.toLowerCase()
      ) {
        throw new Error("Wallet signature verification failed.");
      }

      const response = await fetch("/api/proposals", {
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
      });

      const result = (await response.json()) as {
        success: boolean;
        proposalId?: number;
        error?: string;
      };

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Unable to publish proposal.");
      }

      setMessage(
        `Proposal #${result.proposalId} published successfully!`
      );

      setTitle("");
      setDescription("");
      setOptions(["", ""]);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Publishing failed."
      );
    } finally {
      setBusy(false);
    }
  }

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

      <p>Create community voting proposals.</p>

      {!wallet ? (
        <button onClick={connectWallet}>
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
          This wallet is not authorized to create proposals.
        </p>
      )}

      {isAdmin && (
        <div style={{ display: "grid", gap: 14 }}>
          <label>
            Proposal Title
            <input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Which parlay should we play?"
              style={{ width: "100%", padding: 12 }}
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
              style={{ width: "100%", padding: 12 }}
            />
          </label>

          <h3 style={{ color: "#ffe19a" }}>
            Voting Options
          </h3>

          {options.map((option, index) => (
            <div
              key={index}
              style={{ display: "flex", gap: 8 }}
            >
              <input
                value={option}
                maxLength={200}
                placeholder={`Option ${index + 1}`}
                onChange={(event) =>
                  setOptions((previous) =>
                    previous.map((value, i) =>
                      i === index ? event.target.value : value
                    )
                  )
                }
                style={{ flex: 1, padding: 12, minWidth: 0 }}
              />

              <button
                disabled={options.length <= 2}
                onClick={() =>
                  setOptions((previous) =>
                    previous.filter((_, i) => i !== index)
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
              setOptions((previous) => [...previous, ""])
            }
          >
            + Add Voting Option
          </button>

          <label>
            Voting Duration
            <select
              value={durationHours}
              onChange={(event) =>
                setDurationHours(Number(event.target.value))
              }
              style={{ width: "100%", padding: 12 }}
            >
              <option value={24}>24 hours</option>
              <option value={48}>48 hours</option>
              <option value={72}>72 hours</option>
            </select>
          </label>

          <button
            disabled={busy}
            onClick={publishProposal}
            style={{
              padding: 16,
              background: "#e6bb53",
              color: "#ffffff",
              fontWeight: "bold",
              border: 0,
              borderRadius: 10
            }}
          >
            {busy
              ? "Waiting for Wallet..."
              : "SIGN & PUBLISH PROPOSAL"}
          </button>
        </div>
      )}

      {message && (
        <p role="status" style={{ marginTop: 20 }}>
          {message}
        </p>
      )}
    </main>
  );
}
