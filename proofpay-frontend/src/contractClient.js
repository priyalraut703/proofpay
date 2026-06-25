import {
  Contract,
  rpc,
  TransactionBuilder,
  Networks,
  nativeToScVal,
  scValToNative,
  Address,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import {
  isConnected,
  requestAccess,
  signTransaction,
  getAddress,
} from "@stellar/freighter-api";

// ---- Config: your deployed contract + network ----
export const PROOFPAY_CONTRACT_ID =
  "CDNCMTMXO5UCA6VXN4ANOGOLGPFBM22JUCZD7ZNGCCRUOQAJVZEQB23I";
export const XLM_TOKEN_CONTRACT_ID =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

const server = new rpc.Server(RPC_URL, { allowHttp: false });

// ---- Wallet connection ----

export async function connectWallet() {
  const connected = await isConnected();
  if (!connected.isConnected) {
    throw new Error(
      "Freighter not detected. Install the Freighter browser extension."
    );
  }
  const access = await requestAccess();
  if (access.error) {
    throw new Error(access.error);
  }
  return access.address;
}

export async function getConnectedAddress() {
  const result = await getAddress();
  if (result.error) return null;
  return result.address || null;
}

// ---- Core: build, sign, submit a contract call ----

async function callContract(contractId, method, args, sourceAddress) {
  const contract = new Contract(contractId);
  const account = await server.getAccount(sourceAddress);

  let tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  // Simulate to get the correct footprint/resource fees, then prepare.
  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }
  tx = rpc.assembleTransaction(tx, simResult).build();

  const signed = await signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  if (signed.error) {
    throw new Error(signed.error);
  }

  const { Transaction } = await import("@stellar/stellar-sdk");
  const signedTx = new Transaction(signed.signedTxXdr, NETWORK_PASSPHRASE);

  const sendResult = await server.sendTransaction(signedTx);
  if (sendResult.status === "ERROR") {
    throw new Error("Transaction submission failed.");
  }

  // Poll until the transaction is confirmed.
  let getResult = await server.getTransaction(sendResult.hash);
  let attempts = 0;
  while (getResult.status === "NOT_FOUND" && attempts < 15) {
    await new Promise((r) => setTimeout(r, 1500));
    getResult = await server.getTransaction(sendResult.hash);
    attempts++;
  }

  if (getResult.status !== "SUCCESS") {
    throw new Error(`Transaction did not succeed: ${getResult.status}`);
  }

  const returnValue = getResult.returnValue
    ? scValToNative(getResult.returnValue)
    : null;

  return { hash: sendResult.hash, returnValue };
}

// ---- Read-only call (simulate only, no signing needed) ----

async function readContract(contractId, method, args) {
  const contract = new Contract(contractId);
  // Use any funded throwaway-readable account context for simulation.
  const dummyAccount = new (
    await import("@stellar/stellar-sdk")
  ).Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Read failed: ${simResult.error}`);
  }
  return scValToNative(simResult.result.retval);
}

// ---- ProofPay contract methods ----

export async function createJob({
  clientAddress,
  freelancerAddress,
  amountStroops,
  deadlineUnix,
}) {
  const args = [
    new Address(clientAddress).toScVal(),
    new Address(freelancerAddress).toScVal(),
    new Address(XLM_TOKEN_CONTRACT_ID).toScVal(),
    nativeToScVal(amountStroops, { type: "i128" }),
    nativeToScVal(deadlineUnix, { type: "u64" }),
  ];
  return callContract(PROOFPAY_CONTRACT_ID, "create_job", args, clientAddress);
}

export async function submitProof({ jobId, freelancerAddress, proofHashBytes }) {
  const args = [
    nativeToScVal(jobId, { type: "u64" }),
    new Address(freelancerAddress).toScVal(),
    nativeToScVal(proofHashBytes, { type: "bytes" }),
  ];
  return callContract(
    PROOFPAY_CONTRACT_ID,
    "submit_proof",
    args,
    freelancerAddress
  );
}

export async function approveJob({ jobId, clientAddress }) {
  const args = [
    nativeToScVal(jobId, { type: "u64" }),
    new Address(clientAddress).toScVal(),
  ];
  return callContract(PROOFPAY_CONTRACT_ID, "approve", args, clientAddress);
}

export async function rejectJob({ jobId, clientAddress }) {
  const args = [
    nativeToScVal(jobId, { type: "u64" }),
    new Address(clientAddress).toScVal(),
  ];
  return callContract(PROOFPAY_CONTRACT_ID, "reject", args, clientAddress);
}

export async function autoRelease({ jobId, callerAddress }) {
  const args = [nativeToScVal(jobId, { type: "u64" })];
  return callContract(
    PROOFPAY_CONTRACT_ID,
    "auto_release",
    args,
    callerAddress
  );
}

export async function getJobDetails(jobId) {
  const args = [nativeToScVal(jobId, { type: "u64" })];
  return readContract(PROOFPAY_CONTRACT_ID, "get_job_details", args);
}

// ---- Utility: turn arbitrary text/link into a 32-byte hash for proof submission ----

export async function hashProofText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}