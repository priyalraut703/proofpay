import { useState, useCallback, useEffect } from "react";
import {
  connectWallet,
  getConnectedAddress,
  createJob,
  submitProof,
  approveJob,
  rejectJob,
  autoRelease,
  getJobDetails,
  hashProofText,
  bytesToHex,
} from "./contractClient";
import { useProofPayEvents } from "./useEvents";
import { scValToNative } from "@stellar/stellar-sdk";
import "./App.css";

const STATUS_LABELS = {
  0: "Pending",
  1: "Submitted",
  2: "Approved",
  3: "Rejected",
  4: "Auto-Released",
};

const STATUS_CLASS = {
  0: "status-pending",
  1: "status-submitted",
  2: "status-approved",
  3: "status-rejected",
  4: "status-approved",
};

function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function App() {
  const [address, setAddress] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [jobs, setJobs] = useState({}); // jobId -> job details
  const [trackedJobIds, setTrackedJobIds] = useState([]);
  const [loadingJobId, setLoadingJobId] = useState(null);

  const [freelancerInput, setFreelancerInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [deadlineMinutes, setDeadlineMinutes] = useState("10");
  const [creating, setCreating] = useState(false);

  const [proofInputs, setProofInputs] = useState({});
  const [lastTxHash, setLastTxHash] = useState(null);

  const events = useProofPayEvents(5000);

  useEffect(() => {
    getConnectedAddress().then((addr) => addr && setAddress(addr));
  }, []);

  

  const refreshJob = useCallback(async (jobId) => {
    try {
      const details = await getJobDetails(jobId);
      setJobs((prev) => ({ ...prev, [jobId]: details }));
    } catch (err) {
      console.warn(`Could not refresh job ${jobId}:`, err.message);
    }
  }, []);

  useEffect(() => {
    trackedJobIds.forEach(refreshJob);
    const interval = setInterval(() => {
      trackedJobIds.forEach(refreshJob);
    }, 8000);
    return () => clearInterval(interval);
  }, [trackedJobIds, refreshJob]);

  async function handleConnect() {
    setError(null);
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setAddress(addr);
    } catch (err) {
      setError(err?.message || JSON.stringify(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleCreateJob(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setCreating(true);
    try {
      const amountStroops = Math.round(parseFloat(amountInput) * 10_000_000);
      const deadlineUnix =
        Math.floor(Date.now() / 1000) + parseInt(deadlineMinutes, 10) * 60;

      const { hash, returnValue } = await createJob({
        clientAddress: address,
        freelancerAddress: freelancerInput.trim(),
        amountStroops,
        deadlineUnix,
      });

      setLastTxHash(hash);
      const newJobId = Number(returnValue);
      setTrackedJobIds((prev) =>
        prev.includes(newJobId) ? prev : [...prev, newJobId]
      );
      await refreshJob(newJobId);
      setNotice(`Job #${newJobId} created. Funds locked in escrow.`);
      setFreelancerInput("");
      setAmountInput("");
    } catch (err) {
      setError(err?.message || JSON.stringify(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleTrackJob(jobIdStr) {
    const jobId = parseInt(jobIdStr, 10);
    if (Number.isNaN(jobId)) return;
    setTrackedJobIds((prev) =>
      prev.includes(jobId) ? prev : [...prev, jobId]
    );
    await refreshJob(jobId);
  }

  async function handleSubmitProof(jobId) {
    setError(null);
    setNotice(null);
    setLoadingJobId(jobId);
    try {
      const text = proofInputs[jobId] || "";
      if (!text.trim()) {
        throw new Error("Enter a link or description of your work first.");
      }
      const hashBytes = await hashProofText(text);
      const { hash } = await submitProof({
        jobId,
        freelancerAddress: address,
        proofHashBytes: hashBytes,
      });
      setLastTxHash(hash);
      setNotice(`Proof submitted for job #${jobId}.`);
      await refreshJob(jobId);
    } catch (err) {
      setError(err?.message || JSON.stringify(err));
    } finally {
      setLoadingJobId(null);
    }
  }

  async function handleApprove(jobId) {
    setError(null);
    setNotice(null);
    setLoadingJobId(jobId);
    try {
      const { hash } = await approveJob({ jobId, clientAddress: address });
      setLastTxHash(hash);
      setNotice(`Job #${jobId} approved. Funds released to freelancer.`);
      await refreshJob(jobId);
    } catch (err) {
      setError(err?.message || JSON.stringify(err));
    } finally {
      setLoadingJobId(null);
    }
  }

  async function handleReject(jobId) {
    setError(null);
    setNotice(null);
    setLoadingJobId(jobId);
    try {
      const { hash } = await rejectJob({ jobId, clientAddress: address });
      setLastTxHash(hash);
      setNotice(`Job #${jobId} rejected. Freelancer may resubmit.`);
      await refreshJob(jobId);
    } catch (err) {
      setError(err?.message || JSON.stringify(err));
    } finally {
      setLoadingJobId(null);
    }
  }

  async function handleAutoRelease(jobId) {
    setError(null);
    setNotice(null);
    setLoadingJobId(jobId);
    try {
      const { hash } = await autoRelease({ jobId, callerAddress: address });
      setLastTxHash(hash);
      setNotice(`Job #${jobId} auto-released after deadline.`);
      await refreshJob(jobId);
    } catch (err) {
      setError(err?.message || JSON.stringify(err));
    } finally {
      setLoadingJobId(null);
    }
  }

  return (
    <div className="ledger-app">
      <header className="ledger-header">
        <div className="brand">
          <span className="brand-mark">⟡</span>
          <div className="brand-text">
            <h1>ProofPay</h1>
            <p className="brand-sub">
               Secure escrow for freelance work - proof in, payment out.
           </p>
          </div>
        </div>

        <div className="wallet-box">
          {address ? (
            <div className="wallet-connected">
              <span className="wallet-dot" />
              <span className="wallet-addr" title={address}>
                {shortAddr(address)}
              </span>
            </div>
          ) : (
            <button
              className="btn-seal"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? "Connecting…" : "Connect Freighter"}
            </button>
          )}
        </div>
      </header>
      <section className="how-it-works">
        <div className="how-step">
          <span className="how-num">1</span>
          <span className="how-label">Client creates job & locks payment in escrow</span>
        </div>
        <div className="how-arrow">→</div>
        <div className="how-step">
          <span className="how-num">2</span>
          <span className="how-label">Freelancer submits proof of work</span>
        </div>
        <div className="how-arrow">→</div>
        <div className="how-step">
          <span className="how-num">3</span>
          <span className="how-label">Client approves or rejects</span>
        </div>
        <div className="how-arrow">→</div>
        <div className="how-step">
          <span className="how-num">4</span>
          <span className="how-label">Funds release instantly (or auto-release if client goes silent)</span>
        </div>
      </section>

      {error && <div className="banner banner-error">{error}</div>}
      {notice && <div className="banner banner-notice">{notice}</div>}
      {lastTxHash && (
        <div className="banner banner-tx">
          Last transaction:{" "}
          
           <a href={`https://stellar.expert/explorer/testnet/tx/${lastTxHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {shortAddr(lastTxHash)} ↗
          </a>
        </div>
      )}

      <main className="ledger-main">
        <section className="panel create-panel">
          <h2 className="panel-title">
            <span className="eyebrow">New Contract</span>
            Open a job in escrow
          </h2>
          <form onSubmit={handleCreateJob} className="create-form">
            <label>
              Freelancer address
              <input
                type="text"
                placeholder="G..."
                value={freelancerInput}
                onChange={(e) => setFreelancerInput(e.target.value)}
                required
                disabled={!address}
              />
            </label>
            <div className="form-row">
              <label>
                Amount (XLM)
                <input
                  type="number"
                  min="0.0000001"
                  step="any"
                  placeholder="50"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  required
                  disabled={!address}
                />
              </label>
              <label>
                Deadline (minutes from now)
                <input
                  type="number"
                  min="1"
                  value={deadlineMinutes}
                  onChange={(e) => setDeadlineMinutes(e.target.value)}
                  required
                  disabled={!address}
                />
              </label>
            </div>
            <button
              type="submit"
              className="btn-seal btn-block"
              disabled={!address || creating}
            >
              {creating ? "Locking funds…" : "Create job & lock escrow"}
            </button>
            {!address && (
              <p className="hint">Connect your wallet to create a job.</p>
            )}
          </form>
        </section>

        <section className="panel track-panel">
          <h2 className="panel-title">
            <span className="eyebrow">Lookup</span>
            Track an existing job
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleTrackJob(e.target.jobid.value);
              e.target.jobid.value = "";
            }}
            className="track-form"
          >
            <input
              name="jobid"
              type="number"
              min="1"
              placeholder="Job ID, e.g. 1"
            />
            <button type="submit" className="btn-ghost">
              Track
            </button>
          </form>
        </section>

        <section className="jobs-panel">
          <h2 className="panel-title">
            <span className="eyebrow">Ledger</span>
            Tracked jobs
          </h2>

          {trackedJobIds.length === 0 && (
            <p className="empty-state">
              No jobs tracked yet. Create one above, or track a job ID
              shared with you.
            </p>
          )}

          <div className="job-grid">
            {trackedJobIds.map((jobId) => {
              const job = jobs[jobId];
              if (!job) return null;
              const isClient = address === job.client;
              const isFreelancer = address === job.freelancer;
              const deadlinePassed =
                Date.now() / 1000 > Number(job.deadline);

              return (
                <article
                  key={jobId}
                  className={`job-card ${STATUS_CLASS[job.status] || ""}`}
                >
                  <div className="job-card-edge" />
                  <div className="job-card-body">
                    <div className="job-card-top">
                      <span className="job-id">Job #{jobId}</span>
                      <span
                        className={`stamp ${STATUS_CLASS[job.status] || ""}`}
                      >
                        {STATUS_LABELS[job.status] ?? "Unknown"}
                      </span>
                    </div>

                    <dl className="job-meta">
                      <div>
                        <dt>Client</dt>
                        <dd>{shortAddr(job.client)}</dd>
                      </div>
                      <div>
                        <dt>Freelancer</dt>
                        <dd>{shortAddr(job.freelancer)}</dd>
                      </div>
                      <div>
                        <dt>Amount</dt>
                        <dd>{(Number(job.amount) / 10_000_000).toFixed(2)} XLM</dd>
                      </div>
                      <div>
                        <dt>Deadline</dt>
                        <dd>
                          {new Date(
                            Number(job.deadline) * 1000
                          ).toLocaleString()}
                        </dd>
                      </div>
                      {job.proof_hash && (
                        <div className="proof-row">
                          <dt>Proof hash</dt>
                          <dd className="mono">
                            {bytesToHex(job.proof_hash).slice(0, 24)}…
                          </dd>
                        </div>
                      )}
                    </dl>

                    <div className="job-actions">
                      {isFreelancer &&
                        (job.status === 0 || job.status === 3) && (
                          <div className="proof-submit">
                            <input
                              type="text"
                              placeholder="Link or description of delivered work"
                              value={proofInputs[jobId] || ""}
                              onChange={(e) =>
                                setProofInputs((prev) => ({
                                  ...prev,
                                  [jobId]: e.target.value,
                                }))
                              }
                            />
                            <button
                              className="btn-seal"
                              onClick={() => handleSubmitProof(jobId)}
                              disabled={loadingJobId === jobId}
                            >
                              {loadingJobId === jobId
                                ? "Submitting…"
                                : "Submit proof"}
                            </button>
                          </div>
                        )}

                      {isClient && job.status === 1 && (
                        <div className="approve-row">
                          <button
                            className="btn-seal btn-approve"
                            onClick={() => handleApprove(jobId)}
                            disabled={loadingJobId === jobId}
                          >
                            {loadingJobId === jobId ? "Stamping…" : "Approve & pay"}
                          </button>
                          <button
                            className="btn-ghost btn-reject"
                            onClick={() => handleReject(jobId)}
                            disabled={loadingJobId === jobId}
                          >
                            Reject
                          </button>
                        </div>
                      )}

                      {job.status === 1 && deadlinePassed && (
                        <button
                          className="btn-ghost"
                          onClick={() => handleAutoRelease(jobId)}
                          disabled={loadingJobId === jobId}
                        >
                          {loadingJobId === jobId
                            ? "Releasing…"
                            : "Trigger auto-release (deadline passed)"}
                        </button>
                      )}

                      {(job.status === 2 || job.status === 4) && (
                        <p className="job-final">
                          Funds released to freelancer. Contract closed.
                        </p>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel events-panel">
          <h2 className="panel-title">
            <span className="eyebrow">Live</span>
            On-chain event stream
          </h2>
          <div className="events-list">
            {events.length === 0 && (
              <p className="empty-state">
                Listening for ProofPay events on testnet…
              </p>
            )}
            {events.slice(0, 12).map((e) => {
  let topicLabels = [];
  try {
    topicLabels = e.topic?.map((t) => {
      const decoded = scValToNative(t);
      return typeof decoded === "object" ? JSON.stringify(decoded) : String(decoded);
    });
  } catch {
    topicLabels = ["(unreadable topic)"];
  }
  return (
    <div key={e.id} className="event-row">
      <span className="event-ledger">#{e.ledger}</span>
      <span className="event-topic mono">{topicLabels.join(" · ")}</span>
    </div>
  );
})}
          </div>
        </section>
      </main>

      <footer className="ledger-footer">
        <p>
          ProofPay runs entirely on Stellar testnet. Contract{" "}
          
            className="mono"
            <a href="https://stellar.expert/explorer/testnet/contract/CDNCMTMXO5UCA6VXN4ANOGOLGPFBM22JUCZD7ZNGCCRUOQAJVZEQB23I"
            target="_blank"
            rel="noreferrer"
          >
            CDNCMT…VZEQB23I ↗
          </a>
        </p>
      </footer>
    </div>
  );
}

export default App;