PARLAY Governance

Blockchain-Based, Token-Weighted Community Voting

Developed by ApeLevel | Powered by Robinhood Chain

Project status: Public Beta — Active Development
Last updated: October 22, 2026
License: MIT

Live Application: https://parlay.apelevel.workers.dev/

Source Repository: https://github.com/apelevel/parlay

⸻

1. Project Overview

PARLAY Governance is a custom blockchain-integrated voting platform developed by ApeLevel for the $PARLAY cryptocurrency community.

The platform enables eligible token holders to participate in community voting on proposed wagers.

Unlike conventional polling applications, voting influence is proportional to token ownership rather than the number of participating wallets.

1 $PARLAY = 1 weighted vote.

PARLAY introduces an additional governance mechanism: voting power is measured against token ownership at the ballot’s designated closing block, rather than being permanently established when a user initially submits their preference.

The result is a system connecting community preferences, economic exposure, and blockchain-verifiable ownership.

Voting is nonbinding. The designated proposer retains final discretion over wager execution.

The platform is intended to operate without requiring users to stake or deposit their tokens.

⸻

2. The Governance Model

Token-Weighted Voting

Each eligible wallet’s voting influence is determined by its verified $PARLAY holdings at the ballot’s closing block.

For example:

* A voter submits a ballot while holding 10,000 PARLAY.
* Before the voting deadline, the voter purchases another 40,000 tokens.
* At the closing block, the wallet holds 50,000 PARLAY.
* The wallet’s eligible voting weight is therefore 50,000.

Conversely, a participant who sells their entire balance before the closing block loses their voting weight.

This design creates an economic relationship between expressed preferences and continuing token ownership.

Historical Blockchain Snapshots

The system’s snapshot mechanism separates two events:

1. The closing of the voting period.
2. The subsequent computation and finalization of voting weights.

When a ballot closes, the system identifies the historical blockchain block corresponding to the closing time.

Token balances can subsequently be retrieved against that historical block.

This is particularly important because blockchain queries do not necessarily need to be executed at the exact second voting closes.

Historical balance verification can be performed afterward, subject to RPC capabilities, rate limits, and successful completion of the reconciliation process.

This architecture reduces the need for simultaneous balance queries across every participating wallet.

Gasless Participation

The voting design does not require participants to transfer their $PARLAY tokens into a governance contract.

Ballot submission is intended to occur without an on-chain voting transaction or participant-paid transaction gas.

Blockchain infrastructure is used to authenticate holdings and establish voting influence.

Ballot submissions and related application data are handled through the platform’s backend.

Nonbinding Governance

PARLAY Governance is an advisory voting platform.

Token-weighted results communicate the collective preferences of participating holders but do not automatically execute wagers.

The authorized proposer maintains discretion to cancel, veto, or decline a wager based on technical issues, legal considerations, suspected manipulation, or other legitimate operational concerns.

The platform does not guarantee that the winning voting option will be executed.

⸻

3. Administration and Permissions

The designated governance administration wallet is:

parlayfees.eth

The system is intended to restrict proposal publication and deletion to this authorized administrative identity.

Ordinary token holders participate as voters, not governance administrators.

Administrative permissions and voting eligibility are separate concepts.

Administrative operations should always be authenticated and authorized through server-side verification. Client-side wallet display or interface restrictions alone are insufficient.

Historical voting records should remain publicly accessible where possible to preserve community transparency.

⸻

4. Technical Architecture

PARLAY Governance uses a modern web application stack and Cloudflare infrastructure.

Component	Technology
Frontend	React, TypeScript, Vite
Wallet integration	wagmi, viem
Blockchain	Robinhood Chain
Network ID	4663
Token standard	ERC-20
Hosting / backend	Cloudflare Workers
Database	Cloudflare D1
Scheduling	Cloudflare Cron Triggers
Source control	GitHub
Development	GitHub Codespaces

Blockchain Configuration

Network: Robinhood Chain
Chain ID: 4663

$PARLAY Contract:

0xc4a481c39437680c54a2fdbe170d48a919ec98b7

The platform uses blockchain data to establish token ownership and calculate corresponding governance weight.

Cloudflare Backend

Cloudflare infrastructure provides the application’s hosting, backend execution, database storage, and scheduled processing.

The architecture is intended to avoid dependence on a continuously running dedicated application server.

Cloudflare D1 maintains application records, while scheduled Worker execution supports asynchronous governance tasks, including snapshot reconciliation.

The repository currently configures a scheduled Worker trigger that runs once per minute.

This schedule is not itself proof that every snapshot job completes successfully; actual job completion must be verified through operational testing and logs.

Public Auditability

The project source code is publicly accessible:

https://github.com/apelevel/parlay

Developers, security researchers, and interested community members are invited to inspect the code, report vulnerabilities, and submit constructive improvements.

Public source availability provides an opportunity for independent inspection but does not constitute a completed independent security audit.

⸻

5. Current Development Status

Status as of October 22, 2026: Public Beta

PARLAY Governance has progressed beyond initial deployment and has demonstrated important parts of its governance functionality.

Implemented or Demonstrated

Application deployment

The platform has been deployed publicly using Cloudflare infrastructure.

Token-weighted voting

The application implements the PARLAY governance concept, connecting eligible voting weight to cryptocurrency ownership.

Historical snapshot processing

Following substantial debugging, the historical closing-block snapshot mechanism has produced a successful demonstration.

The system is designed to reference the correct historical block instead of substituting the blockchain state at the later time a balance query executes.

This represents an important architectural milestone.

Persistent ballot records

The platform maintains ballot information through its backend and database architecture.

A completed voting demonstration and its associated records have been presented through the public application.

Scheduled processing

The repository contains Cloudflare scheduled processing configuration to support backend automation.

Open-source availability

The application source code is publicly available for inspection.

Known Limitations and Unresolved Work

Successful demonstration of the historical snapshot process does not mean all governance functionality has completed production-grade testing.

Outstanding work includes:

* Wallet compatibility issues affecting some participants.
* Browser and wallet-provider selection inconsistencies.
* Security warnings displayed by MetaMask and Coinbase Wallet.
* Further testing of historical balance queries under different network and RPC conditions.
* Verification of server-side access controls.
* Greater transparency of snapshot finalization and failure handling.
* Additional testing of multiple simultaneous voters and voting periods.

Current status should not be interpreted as a completed security certification or comprehensive independent audit.

⸻

6. Development Roadmap

Priority 1 — Snapshot Reliability and Historical Verification

Status: Initial successful demonstration; further validation required.

The historical closing-block calculation is one of the project’s most important technical achievements.

Further work will focus on:

* Confirming consistent identification of closing blocks.
* Verifying historical token balances across supported RPC providers.
* Testing reconciliation under rate limiting and delayed processing.
* Preventing duplicate or inconsistent ballot finalization.
* Recording errors and retrying failed operations safely.
* Ensuring that finalized ballot weights always reference the intended historical block.
* Preserving evidence of successful snapshot calculations.

Completion standard: Multiple ballots finalize consistently, including after delayed processing, restarts, or temporary RPC failures.

Priority 2 — Wallet Connectivity and Provider Selection

Status: Unresolved for some users.

Wallet connectivity remains one of the principal usability obstacles.

Some participants cannot connect their preferred wallet or encounter unexpected provider-selection behavior.

Planned improvements include:

* More reliable identification of available wallet providers.
* Better compatibility with MetaMask and Coinbase Wallet.
* Appropriate support for mobile wallet browsers.
* Clearer handling of unsupported networks.
* User-friendly error messages.
* Testing across desktop and mobile environments.

Completion standard: Supported users can reliably select and authenticate with their intended wallet without unintended provider substitutions.

Priority 3 — Security Classification and Wallet Trust

Status: Active issue.

The PARLAY website has displayed security warnings in MetaMask and Coinbase Wallet.

These warnings are being treated seriously.

The immediate objective is to identify whether the classifications originate from application behavior, shared security blocklists, automated reputation systems, or another technical concern.

Required actions include:

* Requesting manual review through wallet-provider security channels.
* Providing public source code for inspection.
* Reviewing wallet signatures and requested permissions.
* Verifying that voting does not require unnecessary token approvals or transfers.
* Correcting any legitimate security findings.
* Requesting removal of incorrect classifications once the application is verified.

A security warning should not be bypassed merely because a developer believes the application is legitimate.

Completion standard: Identified security findings are resolved, and applicable wallet providers no longer warn against the verified application without cause.

Priority 4 — Governance Integrity and Backend Hardening

Status: Additional review and testing required.

The next engineering phase will focus on protecting the integrity of the governance lifecycle.

Areas for review include:

* Server-side administrator authorization.
* Wallet-authentication signatures and replay protection.
* Proposal creation, cancellation, and deletion.
* Ballot submission validation.
* Prevention of duplicate or conflicting vote records.
* Immutable closing-block references after finalization.
* Database consistency.
* API rate limiting and abuse protection.
* Audit logging and operational monitoring.
* Automated regression tests.

This includes ensuring that spreading tokens across multiple wallets does not increase the aggregate voting weight beyond the aggregate balances legitimately held, while recognizing that detecting common ownership and preventing manipulation are separate challenges.

Completion standard: Critical governance operations behave consistently and securely under realistic and adversarial test conditions.

Priority 5 — User Experience and Public Documentation

Status: Ongoing.

Future usability improvements include:

* More intuitive voting workflows.
* Clear indications of active and completed ballots.
* Better explanations of token-weighted voting.
* Historical ballot archives.
* Clearer voting deadlines and snapshot information.
* Mobile layout improvements.
* Public status messages for delayed finalization.
* Developer and community documentation.

Completion standard: Users can understand voting eligibility, submit preferences, inspect results, and interpret finalized governance outcomes without developer assistance.

⸻

7. Voting Integrity and Game Theory

The PARLAY governance model is designed to make influence depend on economic ownership rather than simply the number of participating accounts.

This has several consequences.

Wallet Splitting Does Not Automatically Increase Weight

A holder with 100,000 PARLAY in one wallet has the same aggregate token holdings as a holder distributing 100,000 PARLAY across ten wallets.

Assuming balances are queried consistently at the same closing block and ballots are counted correctly, distribution alone does not create additional token-weighted influence.

Temporary Accumulation Creates Economic Exposure

A participant seeking additional voting power may need to acquire additional tokens before the ballot closes.

Such activity can involve transaction costs, token taxes where applicable, slippage, price volatility, and market exposure.

Those costs may discourage short-term manipulation.

However, they do not mathematically prevent manipulation or guarantee that manipulating an advisory vote is irrational.

Snapshot Timing Limits Certain Manipulations

The system is designed to prevent a voter from permanently retaining voting power solely because they briefly held tokens when submitting their ballot.

Instead, holdings are evaluated at the designated closing block.

This establishes a common historical reference point for eligible voting weight.

Remaining Limitations

Token-weighted governance does not establish unique human identity or prevent every form of coordinated behavior.

A participant with sufficient capital can still acquire substantial influence.

The system therefore combines measurable token ownership, historical verification, administrative oversight, and nonbinding execution.

⸻

8. Governance Transparency and Trust

PARLAY Governance should be understood as a blockchain-integrated voting platform, rather than a completely autonomous on-chain governance protocol.

Token balances are determined using blockchain records.

Ballot submissions, application records, and administrative processes are maintained through ApeLevel-controlled infrastructure.

Consequently, users must currently trust the operator to maintain the backend honestly, protect administrative credentials, and preserve ballot integrity.

The long-term objective is to reduce unnecessary trust assumptions through stronger public verification, transparent records, and independently reproducible calculations.

Historical snapshot verification provides a basis for checking voting weights but does not alone prove the integrity of every ballot record.

⸻

9. Development Setup

Developers can clone the public repository and install its dependencies.

git clone https://github.com/apelevel/parlay.git
cd parlay
npm install

Start the frontend development server:

npm run dev

Build the application:

npm run build

Run lint checks:

npm run lint

The project includes Cloudflare Worker and D1 configuration.

Full backend functionality requires the appropriate Cloudflare environment, database bindings, and any necessary application configuration.

Do not expose private keys, administrator credentials, API secrets, or wallet recovery phrases in source code or client-side environment variables.

⸻

10. Security and Responsible Disclosure

PARLAY Governance is under active development.

Developers and security researchers are encouraged to inspect the publicly available code and report potential vulnerabilities responsibly.

Relevant review areas include:

* Wallet authentication.
* Signature validation.
* Administrative access controls.
* Historical balance queries.
* Database integrity.
* API access restrictions.
* Scheduled snapshot finalization.
* Protection against unauthorized ballot modification.

Do not assume that a wallet connection request or signature request is safe simply because it originates from this project’s domain.

Users should inspect wallet permissions and avoid approving unexplained transactions.

Security reports can be submitted through an appropriate private maintainer contact or repository security-reporting mechanism, if enabled.

⸻

11. Important Disclaimers

PARLAY Governance provides advisory community voting functionality.

Participation does not guarantee wager execution, financial returns, or favorable outcomes.

The platform does not represent a promise of profits or an investment product.

Token ownership can involve substantial financial risk.

The governance system does not require users to surrender custody of their tokens merely to express a voting preference.

No claim is made that the system is immune to manipulation, security vulnerabilities, operator error, or infrastructure outages.

Community voting outcomes are nonbinding, and authorized administrators retain discretion over subsequent actions.

⸻

12. Project Links

Live Governance Platform
https://parlay.apelevel.workers.dev/

Public GitHub Repository
https://github.com/apelevel/parlay

Blockchain
Robinhood Chain — Chain ID 4663

Governance Token
$PARLAY

Development and Technical Administration
ApeLevel

⸻

Development Philosophy

PARLAY Governance was created to explore how cryptocurrency ownership, community decision-making, and verifiable historical blockchain data can interact within a practical governance application.

Its architecture prioritizes accessibility, low recurring infrastructure costs, and transparent token-weighted participation.

The initial implementation demonstrates that historical blockchain snapshots can support governance calculations without requiring every participant to execute an on-chain transaction.

The next phase is focused on reliability, compatibility, security, and independent verifiability.

Built by ApeLevel. Developed for PARLAY. Open for inspection.
