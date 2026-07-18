# Riley Okonkwo

Senior Software Engineer
riley.okonkwo@example.com · Bayside, generic metro area · github.com/example-riley

## Summary

Senior backend and platform engineer with nine years of experience building distributed
systems and leading small teams through hard technical migrations. Comfortable owning a
system from architecture through on-call, and drawn to problems at the intersection of
correctness, scale, and developer experience. I do my best work when I can pair a clear
technical vision with hands-on delivery.

## Experience

**Senior Software Engineer / Tech Lead — Fictional Fintech Inc. (4 years)**
Tech lead for the payments-ledger team, owning the services that record and reconcile
every money movement in the platform. Set technical direction and mentored four engineers.

**Software Engineer — Invented Streaming Co. (3 years)**
Worked on the content-delivery and metadata services for a video platform.

**Software Engineer — Made-Up Startup (2 years)**
Early engineer at a small startup; built much of the original backend.

## Projects

#### Double-entry ledger platform (Fictional Fintech Inc.)
- Stack: Go, PostgreSQL, Kafka, Kubernetes
- Summary: Designed and led the build of the immutable double-entry ledger that is now the
  source of truth for all balances. Chose an append-only event model with derived balance
  projections over mutable-row accounting so that every balance is reconstructable and
  auditable, and used per-account serialisable transactions to guarantee no money is ever
  created or destroyed under concurrent writes.
- Metrics: 99.99% availability over 18 months, reconciliation discrepancies reduced to zero, 4,000 transactions/sec sustained

#### Cross-region failover for the ledger (Fictional Fintech Inc.)
- Stack: Go, PostgreSQL, Kubernetes, Terraform
- Summary: Led the project to make the ledger survive a full regional outage. Introduced
  asynchronous replication with a bounded, monitored replication lag and a documented,
  rehearsed failover runbook, deliberately choosing an RPO of a few seconds over the cost
  and latency of synchronous cross-region commits.
- Metrics: recovery time objective cut from 45 minutes to under 4 minutes

#### Metadata service redesign (Invented Streaming Co.)
- Stack: Java, Cassandra, Redis
- Summary: Rebuilt the video-metadata service that was buckling under read load during
  peak hours. Introduced a read-through cache and denormalised the hottest access paths,
  then load-tested against replayed production traffic before rollout.
- Metrics: peak read latency down 60%, database load reduced by roughly half

#### Internal service-scaffolding CLI (Fictional Fintech Inc.)
- Stack: Go, Cookiecutter-style templates
- Summary: A side effort I drove to cut the time to stand up a new Go service. It
  generates a service with logging, metrics, tracing, and a CI pipeline already wired in,
  encoding the team's conventions so new services start on the paved road instead of
  drifting. I built it mostly on Fridays and through internal contributions.
- Metrics: none reported

## Skills

Go, Java, PostgreSQL, Cassandra, Kafka, Redis, Kubernetes, Terraform, AWS, gRPC,
distributed systems design, incident response, technical leadership

## Education

B.S. in Computer Science — regional university
