#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env};

/// Helper: deploys a test token contract and returns (token_address, admin_client)
/// so tests can mint funds before exercising ProofPay logic.
fn create_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, token::StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_address = sac.address();
    let admin_client = token::StellarAssetClient::new(env, &token_address);
    (token_address, admin_client)
}

fn setup() -> (Env, Address, Address, Address, Address, token::StellarAssetClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let client_addr = Address::generate(&env);
    let freelancer_addr = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token_address, token_admin_client) = create_token_contract(&env, &token_admin);

    // Mint 1000 units of the test token to the client so they can fund jobs.
    token_admin_client.mint(&client_addr, &1000);

    let contract_id = env.register(ProofPayContract, ());

    (env, contract_id, client_addr, freelancer_addr, token_address, token_admin_client)
}

#[test]
fn test_create_job_locks_funds_in_escrow() {
    let (env, contract_id, client_addr, freelancer_addr, token_address, _admin) = setup();
    let proofpay = ProofPayContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_address);

    let deadline = env.ledger().timestamp() + 1000;
    let job_id = proofpay.create_job(&client_addr, &freelancer_addr, &token_address, &200, &deadline);

    assert_eq!(job_id, 1);
    // Client balance dropped by 200, contract now holds 200 in escrow.
    assert_eq!(token_client.balance(&client_addr), 800);
    assert_eq!(token_client.balance(&contract_id), 200);

    let job = proofpay.get_job_details(&job_id);
    assert_eq!(job.status, JobStatus::Pending);
    assert_eq!(job.amount, 200);
}

#[test]
fn test_submit_proof_moves_job_to_submitted() {
    let (env, contract_id, client_addr, freelancer_addr, token_address, _admin) = setup();
    let proofpay = ProofPayContractClient::new(&env, &contract_id);

    let deadline = env.ledger().timestamp() + 1000;
    let job_id = proofpay.create_job(&client_addr, &freelancer_addr, &token_address, &200, &deadline);

    let fake_hash = soroban_sdk::BytesN::from_array(&env, &[7u8; 32]);
    proofpay.submit_proof(&job_id, &freelancer_addr, &fake_hash);

    let job = proofpay.get_job_details(&job_id);
    assert_eq!(job.status, JobStatus::Submitted);
    assert_eq!(job.proof_hash, Some(fake_hash));
}

#[test]
fn test_approve_releases_funds_to_freelancer() {
    let (env, contract_id, client_addr, freelancer_addr, token_address, _admin) = setup();
    let proofpay = ProofPayContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_address);

    let deadline = env.ledger().timestamp() + 1000;
    let job_id = proofpay.create_job(&client_addr, &freelancer_addr, &token_address, &200, &deadline);

    let fake_hash = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
    proofpay.submit_proof(&job_id, &freelancer_addr, &fake_hash);
    proofpay.approve(&job_id, &client_addr);

    let job = proofpay.get_job_details(&job_id);
    assert_eq!(job.status, JobStatus::Approved);
    // Freelancer received the escrowed 200, contract now holds 0.
    assert_eq!(token_client.balance(&freelancer_addr), 200);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_reject_allows_resubmission() {
    let (env, contract_id, client_addr, freelancer_addr, token_address, _admin) = setup();
    let proofpay = ProofPayContractClient::new(&env, &contract_id);

    let deadline = env.ledger().timestamp() + 1000;
    let job_id = proofpay.create_job(&client_addr, &freelancer_addr, &token_address, &200, &deadline);

    let bad_hash = soroban_sdk::BytesN::from_array(&env, &[2u8; 32]);
    proofpay.submit_proof(&job_id, &freelancer_addr, &bad_hash);
    proofpay.reject(&job_id, &client_addr);

    let job = proofpay.get_job_details(&job_id);
    assert_eq!(job.status, JobStatus::Rejected);

    // Freelancer can resubmit after rejection.
    let good_hash = soroban_sdk::BytesN::from_array(&env, &[3u8; 32]);
    proofpay.submit_proof(&job_id, &freelancer_addr, &good_hash);

    let job = proofpay.get_job_details(&job_id);
    assert_eq!(job.status, JobStatus::Submitted);
    assert_eq!(job.proof_hash, Some(good_hash));
}

#[test]
fn test_auto_release_after_deadline_protects_freelancer() {
    let (env, contract_id, client_addr, freelancer_addr, token_address, _admin) = setup();
    let proofpay = ProofPayContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_address);

    let deadline = env.ledger().timestamp() + 1000;
    let job_id = proofpay.create_job(&client_addr, &freelancer_addr, &token_address, &200, &deadline);

    let fake_hash = soroban_sdk::BytesN::from_array(&env, &[9u8; 32]);
    proofpay.submit_proof(&job_id, &freelancer_addr, &fake_hash);

    // Client goes silent. Fast-forward ledger time past the deadline.
    env.ledger().set_timestamp(deadline + 1);

    // Anyone (simulated here as just calling it directly) can trigger release.
    proofpay.auto_release(&job_id);

    let job = proofpay.get_job_details(&job_id);
    assert_eq!(job.status, JobStatus::AutoReleased);
    assert_eq!(token_client.balance(&freelancer_addr), 200);
}

#[test]
fn test_auto_release_fails_before_deadline() {
    let (env, contract_id, client_addr, freelancer_addr, token_address, _admin) = setup();
    let proofpay = ProofPayContractClient::new(&env, &contract_id);

    let deadline = env.ledger().timestamp() + 1000;
    let job_id = proofpay.create_job(&client_addr, &freelancer_addr, &token_address, &200, &deadline);

    let fake_hash = soroban_sdk::BytesN::from_array(&env, &[5u8; 32]);
    proofpay.submit_proof(&job_id, &freelancer_addr, &fake_hash);

    // Deadline has NOT passed yet — auto_release should fail.
    let result = proofpay.try_auto_release(&job_id);
    assert!(result.is_err());
}