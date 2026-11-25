# Decisions

| # | Question | Decision | Status |
|---|---|---|---|
| 0 | Hostnames | Web: `odeachime.odea.org` (internal DNS). Teams bot: `odeachime-bot.<domain on Cloudflare>`. | Decided 2026-11-25 |
| 1 | Google Workspace or Microsoft 365? | **Microsoft 365.** Web sign-in through Entra ID (oauth2-proxy); Teams is a first-class channel; roles come from Entra ID groups. | Decided 2026-11-25 |
| 2 | Which model? | **Claude Haiku 5.5** through the Claude API (questions may leave the building). The on-site model stays in the code as an option if a GPU server comes later. | Decided 2026-11-25 (revised: the proposed server has no GPU) |
| 3 | BellForge data: desktop push, or server logs in to the bell device? | **Option A: the BellForge desktop app pushes the calendar**; see [BELLFORGE.md](BELLFORGE.md#decision-3-why-bellforge-pushes-the-calendar-not-the-server-logging-in). The BellForge2.0 changes are not started yet. | Decided 2026-11-25 |
| 4 | Who at launch? | **Staff only** (`ASSISTANT_MIN_ROLE=staff`), enforced by Entra ID groups on web and Teams. | Decided 2026-11-25 |
| 5 | Server | The Xeon Gold 5315Y / 16 GB box runs the app; no GPU needed with Claude. Sizing below kept for a possible later on-site model. | Decided 2026-11-25 |
| 6 | Conversation log retention | Proposal: 30 days, admins only. | Needs admin sign-off |
| 7 | Staff-only documents in search | Allowed via `audience='staff'`; who may upload? | Open |
| 8 | Can teachers' Microsoft 365 Copilot licenses power the assistant? | **No**: a Copilot license isn't API credit another app can spend. Copilot *can* use our data as an agent action; see below. | Answered 2026-11-25 |

## Copilot (decision 8)

A teacher's Microsoft 365 Copilot license pays for using Copilot inside
Microsoft's apps. It can't be used as API credit by another application, and
there are no per-teacher "tokens" our server could borrow. Our server must
have its own model access, which is Claude Haiku 5.5.

The other direction works: **Copilot can call our server.** The tools here
(bell schedules, website search) can be exposed as an MCP server or API plugin.
A *declarative agent* in Microsoft 365 Copilot, or a Copilot Studio agent,
can then answer "what schedule is today?" inside Copilot, using Microsoft's
model and the teacher's license. Trade-offs:
- We don't control the model, prompt or answer quality, and logging is split.
- Write actions (BellForge, phase 6) are harder to make safe there.
- Licensing for agent calls (included, or billed as Copilot Studio credits)
  depends on the school's agreement. Check with the Microsoft account rep.

Plan: the assistant on Claude Haiku is the main product. An "O'Dea data"
Copilot agent is an optional later add-on, and it's cheap to add because
the tools already exist.

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

## Proposed server: Xeon Gold 5315Y, 16 GB RAM, no GPU (evaluated 2026-11-25)

The CPU is 8 cores / 16 threads, Ice Lake, with AVX-512 and up to 8 DDR4-2933 memory channels.

| Job | Verdict |
|---|---|
| Run the app (Caddy, sign-in, orchestrator, Postgres, crawler) with Claude as the model | **Yes, comfortably.** About 2–3 GB of RAM in use. |
| Main on-site model, CPU only | **No.** These are estimates (see the benchmark below): roughly 30–90 s per answer with an 8B model, people wait in line behind each other, and photos take minutes. |
| Small text-only fallback for sensitive questions | **Barely.** A 3–4B model can run, but it's slow and makes more tool-calling mistakes. |

Why CPU-only is slow:
- **Reading the prompt.** Each turn the model reads 3–5K tokens: the instructions, the tool definitions, and the search results. That prompt-reading step is limited by compute. On 8 cores it runs at only tens to low hundreds of tokens a second, so 30–60 s before the first word appears.
- **Writing the answer.** This step is limited by memory bandwidth. 16 GB is probably 1–2 memory sticks, which is 1–2 of the 8 channels: about 25–45 GB/s, or about 4–8 words a second from an 8B model.
- **RAM.** An 8B 4-bit model needs about 6 GB on top of the app's 3 GB. 16 GB fits that but nothing larger.

**Ways to make it work:**
1. **Add a GPU (recommended).** An NVIDIA L4 (24 GB, 72 W, low-profile, powered by the slot, no extra power cable) fits most 1U/2U servers. It turns this box into a good pilot server: an 8–14B vision model answering in a few seconds.
2. **RAM to 64 GB across all 8 channels (8 × 8 GB).** This makes writing answers about 4–6 times faster, but reading the prompt stays slow. It helps, but on its own it isn't enough.
3. **Use the server as is with Claude** (`PRIMARY_MODEL=claude`) for the staff pilot, and add the GPU when the budget arrives.

What the vendor or IT needs to confirm for option 1:
- a free PCIe x16 slot (low-profile or full-height)
- 75 W of power at that slot
- airflow suitable for a passively cooled card (the server's fans must push air through it)
- the server model number

Benchmark to replace these estimates (run it on the server):

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:8b
ollama run qwen3:8b --verbose "Summarize O'Dea High School's bell schedule rules in 5 bullet points: $(head -c 8000 /usr/share/common-licenses/GPL-3)"
```

Read the `prompt eval rate` and `eval rate` lines (tokens a second). For a usable experience you want prompt eval of at least 500/s and eval of at least 15/s.

Until it arrives: `PRIMARY_MODEL=claude` with Claude Haiku 5.5 (about
$0.10 / $0.50 per million input/output tokens; a staff pilot is likely a few
dollars a month).
