import { useEffect, useRef, useState } from "react";
import { rpc } from "@stellar/stellar-sdk";
import { PROOFPAY_CONTRACT_ID, RPC_URL } from "./contractClient";

const server = new rpc.Server(RPC_URL, { allowHttp: false });

/**
 * Polls Soroban for ProofPay contract events and keeps a running log.
 * Real blockchains don't push events over a socket the way a typical
 * REST API might, so polling recent ledgers is the standard approach
 * for "live" UI updates on Soroban testnet.
 */
export function useProofPayEvents(pollMs = 5000) {
  const [events, setEvents] = useState([]);
  const startLedgerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        if (startLedgerRef.current === null) {
          const latest = await server.getLatestLedger();
          // Look back a generous window so a demo run shows recent history too.
          startLedgerRef.current = Math.max(latest.sequence - 200, 1);
        }

        const result = await server.getEvents({
          startLedger: startLedgerRef.current,
          filters: [
            {
              type: "contract",
              contractIds: [PROOFPAY_CONTRACT_ID],
            },
          ],
          limit: 50,
        });

        if (!cancelled && result.events?.length) {
          setEvents((prev) => {
            const existingIds = new Set(prev.map((e) => e.id));
            const fresh = result.events.filter((e) => !existingIds.has(e.id));
            if (fresh.length === 0) return prev;
            return [...fresh, ...prev].slice(0, 100);
          });
          // Advance the cursor so we don't keep re-scanning old ledgers forever.
          const maxLedger = Math.max(...result.events.map((e) => e.ledger));
          startLedgerRef.current = maxLedger + 1;
        }
      } catch (err) {
        // Testnet RPC occasionally rate-limits or has transient errors; just retry next tick.
        console.warn("Event poll failed:", err.message);
      }
    }

    poll();
    const interval = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollMs]);

  return events;
}