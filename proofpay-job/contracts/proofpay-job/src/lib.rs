#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, String,
};

/// ProofPay: Work-Proof-Based Escrow
///
/// Lifecycle of a Job:
///   Pending      -> client created job, funds locked in escrow
///   Submitted    -> freelancer submitted proof of work
///   Approved     -> client approved, funds released to freelancer  (terminal)
///   Rejected     -> client rejected, freelancer may resubmit proof
///   AutoReleased -> deadline passed with no client action, funds auto-released (terminal)
///
/// This prevents both classic freelance scams:
///   - Client ghosting after work is done -> auto_release() saves the freelancer.
///   - Freelancer never delivering -> client never approves, funds simply sit in
///     escrow and are never released; client can also reject so the freelancer
///     must actually submit acceptable proof before getting paid.
#[contract]
pub struct ProofPayContract;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum JobStatus {
    Pending = 0,
    Submitted = 1,
    Approved = 2,
    Rejected = 3,
    AutoReleased = 4,
}

#[contracttype]
#[derive(Clone)]
pub struct Job {
    pub client: Address,
    pub freelancer: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64, // unix timestamp after which auto_release is allowed
    pub status: JobStatus,
    pub proof_hash: Option<BytesN<32>>, // hash of submitted proof (file/link hash)
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Job(u64), // job_id -> Job
    JobCount, // running counter for job ids
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    JobNotFound = 1,
    NotClient = 2,
    NotFreelancer = 3,
    InvalidStatus = 4,
    DeadlineNotReached = 5,
    DeadlineInPast = 6,
    AmountMustBePositive = 7,
}

#[contractimpl]
impl ProofPayContract {
    /// Client creates a job and locks `amount` of `token` into escrow.
    /// Inter-contract call: pulls funds from the client via the token contract's
    /// `transfer` function into this contract's address.
    pub fn create_job(
        env: Env,
        client: Address,
        freelancer: Address,
        token: Address,
        amount: i128,
        deadline: u64,
    ) -> Result<u64, Error> {
        client.require_auth();

        if amount <= 0 {
            return Err(Error::AmountMustBePositive);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::DeadlineInPast);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&client, &env.current_contract_address(), &amount);

        let job_id = Self::next_job_id(&env);

        let job = Job {
            client: client.clone(),
            freelancer: freelancer.clone(),
            token,
            amount,
            deadline,
            status: JobStatus::Pending,
            proof_hash: None,
        };

        env.storage().persistent().set(&DataKey::Job(job_id), &job);

        env.events().publish(
            (String::from_str(&env, "job_created"), job_id),
            (client, freelancer, amount, deadline),
        );

        Ok(job_id)
    }

    /// Freelancer submits proof of work (a 32-byte hash of a file/link/document).
    pub fn submit_proof(
        env: Env,
        job_id: u64,
        freelancer: Address,
        proof_hash: BytesN<32>,
    ) -> Result<(), Error> {
        freelancer.require_auth();

        let mut job: Job = Self::get_job(&env, job_id)?;

        if job.freelancer != freelancer {
            return Err(Error::NotFreelancer);
        }
        if job.status != JobStatus::Pending && job.status != JobStatus::Rejected {
            return Err(Error::InvalidStatus);
        }

        job.proof_hash = Some(proof_hash.clone());
        job.status = JobStatus::Submitted;
        env.storage().persistent().set(&DataKey::Job(job_id), &job);

        env.events().publish(
            (String::from_str(&env, "proof_submitted"), job_id),
            proof_hash,
        );

        Ok(())
    }

    /// Client approves submitted work. Releases escrowed funds to the freelancer.
    /// Inter-contract call: pays the freelancer via the token contract.
    pub fn approve(env: Env, job_id: u64, client: Address) -> Result<(), Error> {
        client.require_auth();

        let mut job: Job = Self::get_job(&env, job_id)?;

        if job.client != client {
            return Err(Error::NotClient);
        }
        if job.status != JobStatus::Submitted {
            return Err(Error::InvalidStatus);
        }

        let token_client = token::Client::new(&env, &job.token);
        token_client.transfer(&env.current_contract_address(), &job.freelancer, &job.amount);

        job.status = JobStatus::Approved;
        env.storage().persistent().set(&DataKey::Job(job_id), &job);

        env.events().publish(
            (String::from_str(&env, "job_approved"), job_id),
            (job.freelancer, job.amount),
        );

        Ok(())
    }

    /// Client rejects submitted work. Job goes back so freelancer can resubmit proof.
    pub fn reject(env: Env, job_id: u64, client: Address) -> Result<(), Error> {
        client.require_auth();

        let mut job: Job = Self::get_job(&env, job_id)?;

        if job.client != client {
            return Err(Error::NotClient);
        }
        if job.status != JobStatus::Submitted {
            return Err(Error::InvalidStatus);
        }

        job.status = JobStatus::Rejected;
        env.storage().persistent().set(&DataKey::Job(job_id), &job);

        env.events()
            .publish((String::from_str(&env, "job_rejected"), job_id), ());

        Ok(())
    }

    /// Anyone can call this once the deadline has passed, if the client never
    /// approved or rejected. This is the anti-scam safety net: a client cannot
    /// simply go silent forever to avoid paying for delivered work.
    /// Inter-contract call: releases escrowed funds to the freelancer.
    pub fn auto_release(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job: Job = Self::get_job(&env, job_id)?;

        if job.status != JobStatus::Submitted {
            return Err(Error::InvalidStatus);
        }
        if env.ledger().timestamp() < job.deadline {
            return Err(Error::DeadlineNotReached);
        }

        let token_client = token::Client::new(&env, &job.token);
        token_client.transfer(&env.current_contract_address(), &job.freelancer, &job.amount);

        job.status = JobStatus::AutoReleased;
        env.storage().persistent().set(&DataKey::Job(job_id), &job);

        env.events().publish(
            (String::from_str(&env, "auto_released"), job_id),
            (job.freelancer, job.amount),
        );

        Ok(())
    }

    /// Read-only: fetch a job's full details. Used by the frontend to render status.
    pub fn get_job_details(env: Env, job_id: u64) -> Result<Job, Error> {
        Self::get_job(&env, job_id)
    }

    // ---- internal helpers ----

    fn next_job_id(env: &Env) -> u64 {
        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::JobCount)
            .unwrap_or(0);
        let next = count + 1;
        env.storage().persistent().set(&DataKey::JobCount, &next);
        next
    }

    fn get_job(env: &Env, job_id: u64) -> Result<Job, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Job(job_id))
            .ok_or(Error::JobNotFound)
    }
}

mod test;