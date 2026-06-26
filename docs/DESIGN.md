# Design Notes

## Why escrow alone isn't enough

A simple escrow contract (lock funds, client releases them) still leaves a freelancer exposed: a client can simply never release funds, and there's no recourse. ProofPay adds two things on top of plain escrow:

1. **On-chain proof submission** — the freelancer's side of the story is recorded immutably, with a timestamp, before any approval decision is made. This means a dispute off-chain ("I never got anything") can't erase the fact that something was submitted on-chain.
2. **Deadline-based auto-release** — the contract itself, not a human, enforces a maximum wait time. If the client doesn't act within the deadline after proof is submitted, *any* address can call `auto_release` to pay the freelancer. This turns "client goes silent" from a permanent trap into a temporary delay.

## State machine
Pending ──submit_proof──▶ Submitted ──approve──▶ Approved (terminal)

│

├──reject──▶ Rejected ──submit_proof──▶ Submitted (loop)

│

└──(deadline passed)──auto_release──▶ AutoReleased (terminal)

Only two states are terminal (`Approved`, `AutoReleased`) — both represent the freelancer being paid. `Rejected` is explicitly *not* terminal, because the goal is to give the freelancer a chance to fix and resubmit rather than lose the job outright.

## Why XLM via the Stellar Asset Contract, not a custom token

Using the native asset's existing Soroban wrapper (the Stellar Asset Contract) means ProofPay's `create_job`, `approve`, and `auto_release` functions all make genuine **inter-contract calls** — the same pattern any real payment integration would use — without ProofPay needing to implement or audit its own token logic. This keeps the trust surface smaller: ProofPay only has to be correct about *escrow and proof logic*, not about token accounting.

## UI design rationale

The interface intentionally avoids a typical "crypto dashboard" look (dark background, neon accent, pill-shaped status badges) in favor of a **notarized ledger / certificate** aesthetic — deep green-black surfaces, a serif display typeface for headings, monospace for addresses and hashes, and circular "stamp" badges for job status. The goal is to visually reinforce what the product actually is: a system for creating verifiable, timestamped proof — closer to a notary's stamp than a stock-trading app.

## Known limitations / future work

- Proof is a hash of arbitrary client-supplied text, not a verified file. A production version would integrate content-addressed storage (e.g. IPFS) so the hash provably corresponds to an actual delivered artifact.
- No milestone/partial-payment support — each job is all-or-nothing.
- No neutral arbitration step beyond reject → resubmit. A genuinely contested job (where the freelancer believes their work meets spec and the client disagrees) currently has no resolution path other than the deadline passing.
- Event streaming uses RPC polling rather than a persistent websocket subscription, which is appropriate for a testnet demo but would benefit from a dedicated indexer in production for lower latency.

