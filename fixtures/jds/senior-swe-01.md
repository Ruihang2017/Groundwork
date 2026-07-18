# Senior Backend Engineer, Distributed Systems — Halyard Systems

## About the role

Halyard Systems provides a payments-orchestration platform that routes transactions
across dozens of payment processors, picking the cheapest reliable path for each charge
in real time. Our customers are large e-commerce companies, and our platform moves
billions of dollars a year. When our system is slow or wrong, our customers lose money
directly — so correctness under load is the whole job.

We are hiring a senior backend engineer for the core routing team, which owns the
services that make the route-selection and settlement decisions on the transaction hot
path.

## What you'll do

- Design and build the distributed services that route, retry, and reconcile payment
  transactions with strict correctness and idempotency guarantees.
- Own latency and reliability on the transaction hot path — we hold a p99 budget of 120
  milliseconds and a five-nines availability target.
- Design data models and event flows that stay consistent across service boundaries, even
  when a downstream processor times out or double-charges.
- Lead the design review for major changes to the routing engine and mentor mid-level
  engineers on distributed-systems thinking.

## Requirements

- 5+ years of backend engineering experience, including at least 2 years building and
  operating distributed systems in production.
- Strong command of a systems-oriented backend language: Go, Java, or Rust. Our stack is
  primarily Go.
- Deep understanding of distributed-systems fundamentals: consistency models, idempotency,
  retries and backoff, exactly-once vs at-least-once delivery, and how to reason about
  partial failure.
- Hands-on experience with a message queue or event-streaming system (Kafka, NATS, or
  similar) and with relational databases (PostgreSQL) under real load.
- A track record of operating what you build: you have carried a pager, debugged a
  production incident at 3am, and written the postmortem afterward.
- Fluency with observability tooling — metrics, distributed tracing, and structured logs.

## Nice to have

- Experience in payments, fintech, or another domain with hard correctness and
  compliance requirements.
- Familiarity with PCI-DSS or SOC 2 controls.
- Experience with gRPC and protocol-buffer-based service contracts.

## Logistics

- Location: New York City, hybrid — three days per week in our Manhattan office.
- We sponsor and transfer H-1B visas and support green-card processing.
- Full-time. Base salary USD 180,000–220,000 plus equity and an annual bonus.
- Participation in an on-call rotation (roughly one week in six) with compensation.

Halyard Systems is an equal-opportunity employer and is committed to a fair, inclusive
hiring process.
