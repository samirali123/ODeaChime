# Decisions

| # | Question | Decision | Status |
|---|---|---|---|
| 1 | Google Workspace or Microsoft 365? | **Microsoft 365.** Web sign-in through Entra ID (oauth2-proxy); Teams is a first-class channel; roles come from Entra ID groups. | Decided 2026-11-25 |
| 2 | Can questions leave the building (Claude API)? | **Yes, allowed**, but the **on-site model is the target primary** for security. Claude is the interim primary until the GPU arrives, then a fallback (`ALLOW_CLAUDE_FALLBACK`), which can be switched off. | Decided 2026-11-25 |
| 3 | BellForge data: desktop push, or server logs in to the bell device? | **Desktop push** recommended; see [BELLFORGE.md](BELLFORGE.md#decision-3-why-bellforge-pushes-the-calendar-not-the-server-logging-in). | Awaiting confirmation |
| 4 | Who at launch? | **Staff only** (`ASSISTANT_MIN_ROLE=staff`), enforced by Entra ID groups on web and Teams. | Decided 2026-11-25 |
| 5 | GPU budget | Coming; sizing below. | Waiting on budget |
| 6 | Conversation log retention | Proposal: 30 days, admins only. | Needs admin sign-off |
| 7 | Staff-only documents in search | Allowed via `audience='staff'`; who may upload? | Open |

## GPU sizing (for decision 5)

The model must handle **tool calling** reliably and, ideally, **read photos**.
Choose it with the evaluation set (`evals/`), not by name. Short-list current
open-weight vision-and-tool models at launch time, run the set on each, and
pick the smallest that scores within a few points of Claude.

| Scope | Concurrency | GPU | Notes |
|---|---|---|---|
| Staff pilot (~100 staff) | a few at once | **one 24 GB card** (RTX 4090/5090 class, or RTX A5000 / L4 for a server chassis) | 7–14B vision model, 4–8-bit quantized, via Ollama |
| Whole school (staff + ~700 students) | lunch-time spikes | **48 GB** (RTX 6000 Ada / L40S) or 2 × 24 GB | Larger model or more parallel requests; consider vLLM instead of Ollama for throughput |

Rest of the server: 8+ CPU cores, 64 GB RAM, 1 TB NVMe, a UPS. Power and
cooling: a 24 GB card draws 300–450 W under load. Plan the room, not just
the budget line.

Until it arrives: `PRIMARY_MODEL=claude` with Claude Haiku 5.5 (about
$0.10 / $0.50 per million input/output tokens; a staff pilot is likely a few
dollars a month).
