# MaskChat Documentation

Technical documentation for the original MaskChat implementation.

| Document | Purpose |
|---|---|
| ARCHITECTURE.md | Identity shielding, matching and realtime chat architecture |
| SETUP.md | Local setup and environment configuration |
| SECURITY.md | Identity privacy, moderation and abuse controls |
| MODERATION.md | Content filtering, reports and bans |
| DEPLOYMENT.md | Vercel, Docker, Redis/Postgres and nginx deployment |
| TESTING.md | Unit, security and realtime verification |

## Product boundary

MaskChat is an anonymous peer-mentorship platform. Identity is verified by the institution-facing authentication layer, then hidden from the other participant through derived aliases and server-side identity separation.

## Source of truth

Implementation, tests and deployment configuration are authoritative. This repository is the original MaskChat implementation; the newer `MaskChat-MERN` repository should be treated as the current rebuilt portfolio version where the two differ.