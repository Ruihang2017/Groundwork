# Sam Delacroix

Software Engineer
sam.delacroix@example.com · Elmwood, generic metro area · github.com/example-sam

## Summary

Full-stack software engineer with four years of experience building and operating
production web applications, mostly in TypeScript and Python. Comfortable owning a
feature end to end and taking a turn on the on-call pager. Motivated by problems where
correctness and performance both matter.

## Experience

**Software Engineer — Fictional SaaS Co. (3 years)**
Built customer-facing features for a B2B scheduling product and helped move the team from
ad-hoc deploys to a proper CI/CD pipeline.

**Junior Software Engineer — Made-Up Digital Agency (1.5 years)**
Delivered client web projects across a range of stacks; learned to ship on a deadline.

## Projects

#### Booking engine rewrite (Fictional SaaS Co.)
- Stack: TypeScript, Node.js, PostgreSQL, Redis
- Summary: Led the rewrite of the availability-checking service that had become a latency
  bottleneck. Replaced a naive per-request database scan with a Redis-backed availability
  cache and an invalidation strategy keyed on booking events, trading a little staleness
  risk for a large latency win, and added idempotency keys so a retried booking could not
  double-book a slot.
- Metrics: p95 latency reduced from 800ms to 110ms, double-booking incidents down to zero

#### Reporting exports pipeline (Fictional SaaS Co.)
- Stack: Python, Celery, PostgreSQL, AWS S3
- Summary: Built the asynchronous CSV/PDF export pipeline so large report generation
  stopped blocking web requests. Moved the work to a Celery queue with progress tracking
  and made the exports resumable after a worker crash by checkpointing row offsets.
- Metrics: handled exports up to 2M rows without timeouts, 30% drop in web-tier error rate

#### Split — shared-expenses side project (personal)
- Stack: TypeScript, Next.js, SQLite
- Summary: A small app for splitting group trip expenses that I maintain in my spare time.
  I modelled balances as an append-only ledger of transactions rather than mutable totals
  so the running balance is always auditable and reconciliation bugs are easy to trace.
- Metrics: none reported

## Skills

TypeScript, JavaScript, Python, React, Next.js, Node.js, PostgreSQL, Redis, Celery,
Docker, AWS (S3, ECS), GitHub Actions

## Education

B.S. in Computer Science — regional university
