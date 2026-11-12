# Security

Please report vulnerabilities privately, not in a public issue.

<!-- MAINTAINERS: replace the next line with the real reporting contact before publishing. -->
**Contact: [maintainers to add a private reporting address or enable GitHub private vulnerability reporting]**

Include what you found, how to reproduce it and which commit you tested.

Sail is beta software and has not been deployed in production. Fixes go to the main branch; there are no supported older releases yet.

Areas where a report is especially useful: tenancy and row-level security, the token types (station, PIN, guest, relay, agent), manager approvals and agent proposals, the guest QR flow and the money invariants. How these work is described in [docs/architecture.md](docs/architecture.md); the settings an operator must change are in [docs/self-hosting.md](docs/self-hosting.md#security-settings-to-change).
