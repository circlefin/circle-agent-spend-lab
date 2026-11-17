# Circle Agent Spend Lab

Spend controls at runtime for an AI agent that pays. A company-approved research agent buys AI model answers in USDC on Arc, and every purchase goes through four steps in code: who is asking, what the rules allow, whether to execute, escalate or deny, and a record of the decision.

![The web chat in offline mode. The purchase is allowed by policy, a simulated payment of 0.002111 USDC goes through, and the Gemini 2.5 Flash answer is marked SIMULATED. The SAFR panel shows all four runtime components checked, and the chat budget shows what was spent.](docs/images/web-chat.png)

> [!WARNING]
> **Live mode spends real USDC.** A live purchase pays a third-party seller in USDC on Arc mainnet. It needs `liveEnabled: true` in [policy.json](policy.json) and the `--live` flag; without `--live`, every command is quote-only. Start with the [offline walkthrough](#quick-start-no-wallet-or-keys), which needs no credentials or funds.

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [How this sample app explores SAFR](#how-this-sample-app-explores-safr)
- [Prerequisites](#prerequisites)
- [Quick start (no wallet or keys)](#quick-start-no-wallet-or-keys)
- [Set up an Agent Wallet](#set-up-an-agent-wallet)
- [Run with a real model and seller](#run-with-a-real-model-and-seller)
- [Project structure](#project-structure)
- [Customize](#customize)
- [Testing](#testing)
- [Security and usage model](#security-and-usage-model)
- [Limits](#limits)
- [Credits](#credits)
- [License](#license)

## What it does

AI agents are starting to make payments, not just recommendations. Testing a model before launch and auditing payments afterwards both help, but neither stops a bad purchase at the moment it happens. This sample app puts the controls at that moment, between what the agent decides and what it pays. The four steps line up with the runtime components in SAFR (Safeguards for Agentic Finance at Runtime), an industry white paper published by the Monetary Authority of Singapore with financial institutions and FinTechs. [How this sample app explores SAFR](#how-this-sample-app-explores-safr) maps each one. It is an exploration for learning, not a certification.

- **Checks who is asking.** The employee and the agent both sign every request. Code checks the signatures and the employee's assignment against a company registry before the model runs.
- **Enforces the company's rules in code.** [policy.json](policy.json) sets the approved seller and models, price caps, a session budget and an approval threshold. A prompt cannot change them.
- **Lets a person pick the provider.** The agent quotes every approved model, priced per request, and the employee chooses one.
- **Pays per request.** It pays with [x402](https://docs.x402.org/introduction) in USDC from a [Circle Agent Wallet](https://developers.circle.com/agent-stack), settled on Arc.
- **Records every purchase decision**, paid or refused, with its [SAFR](#how-this-sample-app-explores-safr) outcome and a link to the onchain receipt. Requests refused before the agent runs, such as an unassigned employee, are journaled too.

It runs in the terminal or as a local web chat, built with TypeScript, [Bun](https://bun.sh) and [LangChain](https://docs.langchain.com/oss/javascript/langchain/agents). Sellers and payment integrations are replaceable.

## How it works

![One purchase, checked before it pays. An employee asks a question, then four steps in code: 1. Who is asking? Signed and assigned. 2. What do the rules allow? Within company policy. 3. Execute, escalate or deny? Auto-Execute pays in USDC on Arc with x402, Escalate asks a person to approve or decline, and Deny means nothing is paid. 4. What happened? Each purchase decision is recorded.](docs/images/spend-controls-flow.png)

Steps 1 to 3 are checks in code, outside the model's control. [How this sample app explores SAFR](#how-this-sample-app-explores-safr) names each one in SAFR's terms.

**Code decides permission; the model judges relevance.**

- Signatures cannot be replaced by a prompt. Each session binds the exact request, service definition and policy, and expires after five minutes.
- Authority is checked again after quotes, after approval and just before payment.
- Concurrent requests reserve the price from the budget in integer micro-USDC. An uncertain payment keeps its reservation and stops later purchases.
- The model never receives identity keys, the policy file or the wallet. Funding the wallet is a separate operator action.

A successful payment does not prove that the answer is right. The model's answer is untrusted data.

## How this sample app explores SAFR

[SAFR (Safeguards for Agentic Finance at Runtime)](https://www.mas.gov.sg/publications/monographs-or-information-paper/2026/safeguards-for-agentic-finance-at-runtime) is an industry white paper that the Monetary Authority of Singapore published with financial institutions and FinTechs under its BuildFin.ai initiative (version 1.1, October 2026). It proposes a reference approach for governing AI agents at runtime: a checkpoint between an agent's decision and its execution, made of four runtime components. SAFR presents itself as a starting point for industry discussion, to be refined through implementation experience. Circle is one of its contributors, and its Circle case study describes an agent that pays for API services per use from an Agent Wallet, the pattern this sample app explores.

The web chat labels each step with its SAFR component, and every saved purchase record carries its SAFR outcome. The terms live in [src/safr.ts](src/safr.ts).

| SAFR component | What SAFR describes | In this sample app | Not covered here |
| --- | --- | --- | --- |
| Agent Identity | Binds each proposed action to a registered agent, verified before any other evaluation | [src/identity.ts](src/identity.ts): the employee and the agent sign each session, and the company registry must list both and assign the employee to the agent | Local keys and a local registry, not an institution's identity system or ERC-8004 |
| Controls Repository | The institution's rulebook that each proposed action is checked against | [policy.json](policy.json) (seller, models, payee, caps, budget, approval threshold), the registry's assignments and each seller's approved scope, checked by [src/policy.ts](src/policy.ts) | No versioned control store or user-provided mandates |
| Disposition Engine | Resolves each in-scope action to Auto-Execute, Observe, Escalate or Deny | [src/harness.ts](src/harness.ts): within the rules, Auto-Execute; above `approvalAboveUsdc`, Escalate to an approver; any failed check, Deny before payment | No Observe outcome, and no risk scoring beyond fixed thresholds |
| Audit Log | A tamper-evident, append-only record of every governance decision | `runs/<session>/journal.jsonl` in `bun run agent`, `bun run chat` and the web chat: one line before each payment and one when the outcome is known, plus requests refused before the agent runs. Each entry keeps the prompt, identity, quote, outcome and SAFR label, and for a paid purchase the amount, transaction hash and seller's answer | Local, append-only files, so not tamper-evident or protected. The offline walkthrough and the evals write no journal |

SAFR also describes a Governance Envelope: one structured record of what the agent proposes, why and with what evidence. Here, the signed session binds the request, the seller definition and the policy, and each record keeps the purpose, input, quote and identity. That covers part of an envelope, not all of it.

This sample app explores SAFR for learning. It is not certified under, compliant with or endorsed by SAFR, and SAFR does not constitute regulatory guidance.

## Prerequisites

- [Bun](https://bun.sh) 1.2.17 or later.
- For real runs only:
  - an OpenAI-compatible model endpoint (Responses or Chat Completions);
  - [Node.js](https://nodejs.org), for the Circle CLI;
  - a Circle Agent Wallet with a little USDC on Arc. [Set up an Agent Wallet](#set-up-an-agent-wallet) walks through it.

## Quick start (no wallet or keys)

The offline walkthrough runs the real LangChain loop and real signature checks. The model's choices, the seller's responses, approvals and payments are scripted fixtures, so it needs no credentials or funds.

```sh
bun install --frozen-lockfile
bun run demo --case answer
```

The `answer` case is a scripted version of a live run. An analyst asks which payment rails are emerging for AI agents. The agent quotes the three approved models, the analyst picks Gemini 2.5 Flash, the company's rules pass, a simulated payment of 0.002111 USDC goes through, and the answer arrives. The seller is a scripted BlockRun.AI fixture ([evals/fixtures/blockrun.json](evals/fixtures/blockrun.json)); nothing calls BlockRun.AI.

Then try the refusals, or run all nine cases:

```sh
bun run demo --case unassigned
bun run demo --case scope
bun run demo --case uncertain
bun run demo
```

<details>
<summary>The nine cases and their results</summary>

| Case | Result | Payments | Simulated USDC |
| --- | --- | ---: | ---: |
| `answer` | Gemini 2.5 Flash answer bought after the analyst's pick | 1 | 0.002111 |
| `unassigned` | Employee is not assigned to this agent | 0 | 0.00 |
| `unknown-agent` | Agent is absent from the company allowlist | 0 | 0.00 |
| `wrong-key` | Copied agent ID fails signature verification | 0 | 0.00 |
| `revoked` | Revoked agent is refused | 0 | 0.00 |
| `scope` | A model that is not approved is refused before any quote | 0 | 0.00 |
| `unsupported` | Live market data is declined without buying | 0 | 0.00 |
| `approval` | Claude Sonnet 5.5 is above the offline approval threshold; the approver declines | 0 | 0.00 |
| `uncertain` | One payment attempt; halts with the price reserved | 0 confirmed | Unknown |

The four identity refusals happen before any model call or quote. The `unsupported` answer is a scripted model choice, not a guarantee from the harness. Every case starts fresh.

</details>

### The web chat, offline

To see the web chat without keys or a wallet:

```sh
bun run web:offline
```

Open http://127.0.0.1:4180. The page, the identity and policy checks, the provider picker and the SAFR panel are the real ones. The agent is scripted to propose one purchase per question, the seller is the scripted BlockRun.AI, and every payment is simulated, so each question gets the same recorded answer and the page marks everything `[SIMULATED]`. Try **Ask as an unassigned employee** to see the refusal.

## Set up an Agent Wallet

Any run with `--payment circle` needs a signed-in wallet, including quote-only runs, because the Circle CLI fetches the live prices. You need USDC in it only for live purchases. Each model answer costs about 0.002 to 0.006 USDC, so 1 USDC covers hundreds of answers.

1. **Install the Circle CLI** and check it:

   ```sh
   npm install -g @circle-fin/cli
   circle --version
   ```

2. **Sign in with your email.** The CLI emails you a code to type in. On first use it also asks you to accept the Circle CLI terms.

   ```sh
   circle wallet login you@example.com
   circle wallet status
   ```

   `status` should show `Type: agent`, `Network: mainnet` and `Status: VALID`.

3. **Find your wallet on Arc.** Your first sign-in usually creates an Agent Wallet on each supported chain. List the Arc one; if the list is empty, run `circle wallet create`.

   ```sh
   circle wallet list --chain ARC --type agent
   # Only if the list is empty: circle wallet create
   ```

   The steps below call its address `<your-arc-address>`.

4. **Fund it with USDC on Arc.** Send USDC on Arc to `<your-arc-address>` from a wallet or account you control, or use the CLI's funding flow (`--method crypto` to deposit from another wallet, `--method fiat` for a card purchase):

   ```sh
   circle wallet fund --address <your-arc-address> --chain ARC --amount 1 --token usdc --method crypto --open
   circle wallet balance --address <your-arc-address> --chain ARC
   ```

5. **Cap what the wallet can spend.** Circle enforces these caps on the wallet itself, separately from [policy.json](policy.json). Each cap must be no larger than the next: per transaction, daily, weekly, monthly.

   ```sh
   circle wallet limit set --address <your-arc-address> --chain ARC \
     --policy-type stablecoin --per-tx 0.05 --daily 1 --weekly 2 --monthly 5
   circle wallet limit --address <your-arc-address> --chain ARC
   ```

   If the wallet already has a stablecoin policy, `set` fails; run `circle wallet limit reset --address <your-arc-address> --chain ARC` first (it also emails you a code). **Setting caps emails you a code that you type into your own terminal. Never give that code to an agent.**

6. **Point this app at the wallet and a model:**

   ```sh
   cp .env.example .env
   ```

   | Variable | Set it to |
   | --- | --- |
   | `CIRCLE_WALLET_ADDRESS` | `<your-arc-address>` |
   | `OPENAI_API_KEY` | Your model provider's key |
   | `OPENAI_MODEL` | The model the agent itself runs on (it needs tool calling). The answers it buys come from the BlockRun.AI models in [policy.json](policy.json) |
   | `OPENAI_BASE_URL` | Only for an OpenAI-compatible endpoint other than OpenAI |
   | `OPENAI_API_MODE` | `responses` (default) or `chat_completions` |

## Run with a real model and seller

1. **Create the example identities** once:

   ```sh
   bun run company init
   ```

   This writes `.local/company.json` and separate employee and agent key files, all git-ignored. `analyst` is assigned to `research-agent`; `observer` is registered but not assigned. No wallet is created. The keys show key possession and local delegation, not company sign-in.

2. **Ask a question, quote-only.** This calls the real model and gets real quotes, but buys nothing:

   ```sh
   bun run agent --service blockrun --payment circle \
     --prompt-file prompts/research.txt
   ```

   Add `--employee .local/observer.json` to see the unassigned employee refused before any call.

3. **Chat in the terminal or the browser:**

   | Command | What you get |
   | --- | --- |
   | `bun run chat` | A terminal chat. Each question is signed and checked as its own session; one budget covers the whole chat |
   | `bun run web` | A local web chat at http://127.0.0.1:4180 with a provider picker, refusal cards, the SAFR panel, a record panel and a budget meter. `bun run web:offline` shows the same page with no keys |

   The web chat never shows wallet or payee addresses. If no provider is picked within 120 seconds, nothing is bought. With this policy no live purchase reaches the approval card: the 0.01 USDC cap on `chat_completion` refuses any dearer quote first. The offline `approval` case lowers the threshold to 0.004 USDC to show the flow.

4. **Make a live purchase.** Review [policy.json](policy.json), set `liveEnabled` to `true`, then add `--live` to `bun run agent`, `bun run chat` or `bun run web`. Payment outcomes and receipts go to the `runs/` folder.

The terminal chat has no provider picker, so there the agent picks from the approved models.

## Project structure

Read the code in this order:

| File | What to look for |
| --- | --- |
| [evals/demo.ts](evals/demo.ts) | The complete offline example, simulated funding and the observed outcomes |
| [src/identity.ts](src/identity.ts) | Employee and agent signatures, assignments, revocation and five-minute sessions |
| [src/agent.ts](src/agent.ts) | The LangChain loop, model instructions and typed tools |
| [src/harness.ts](src/harness.ts) | Purchase checks, atomic reservations, approval and execution |
| [src/policy.ts](src/policy.ts) | Policy schema and quote checks: payee, network, caps, budget and purchase count |
| [src/safr.ts](src/safr.ts) | SAFR's runtime components and outcomes, as the sample app's checks use them |
| [services/blockrun/](services/blockrun/) | The live Arc seller: operation schema, the check against the approved models in policy.json, the 400-token output cap and the fixed company system message |
| [evals/](evals/) | The offline walkthrough, the eval cases and scoring, the scripted BlockRun.AI fixture and the offline web chat |
| [src/main.ts](src/main.ts) and [payments/](payments/) | The real-model entry point and the payment integration |
| [src/web.ts](src/web.ts) and [web/index.html](web/index.html) | The local web chat, with the SAFR panel |

[AGENTS.md](AGENTS.md) is for coding assistants that edit this repo.

## Customize

| Change | Where |
| --- | --- |
| The research question | [prompts/research.txt](prompts/research.txt) |
| Assigned employees, approved agents, allowed services or revocation | The generated `.local/company.json`: remove an assignment or set `active: false` |
| Operations, payees, network, caps, approved models and the approval threshold | [policy.json](policy.json) for live sellers, [evals/offline-policy.json](evals/offline-policy.json) for fixtures. Per-operation caps override the per-request default |
| Let a person choose an input, such as the model | The operation's `choice` metadata, naming the field and the policy list; see [services/blockrun/service.json](services/blockrun/service.json) |
| Add a seller | Copy `services/_template` to `services/myseller`, then set its ID (it must match the folder name), HTTPS origin, instructions and strict operation schemas |
| Allow that seller | Add `services.myseller` to [policy.json](policy.json) and `myseller` to the agent's services in `.local/company.json`. The web chat offers Arc sellers only |
| Test that seller | Add `evals/fixtures/myseller.json` and a `services.myseller` entry in [evals/offline-policy.json](evals/offline-policy.json) |
| Another payment integration | Implement [PaymentFactory](src/payment.ts) as the default export of `payments/<name>.ts`, then pass `--payment <name>` |

Payment adapters supply `quote` and `pay`, honor the price ceiling, and tell a failure before payment apart from an uncertain one.

## Testing

```sh
bun run check
bun run demo
bun run eval --service blockrun --offline
bun run eval --service _template --offline
```

| Check (November 11, 2026, fresh install) | Result |
| --- | ---: |
| Type checking and tests | 137 tests passed |
| Company-agent walkthrough | 9/9 |
| BlockRun.AI fixture, offline cases | 11/11 |
| Template seller, offline cases | 11/11 |

The tests cover the real agent loop, identity forgery and revocation, delayed approvals, concurrent reservations, depleted funds, price changes, uncertain payments, seller errors after payment, instructions injected into seller answers, and purchases reported wrongly or not at all. Offline checks verify mechanisms and scoring, not model intelligence.

**Live on Arc, November 10 and 11, 2026.** Five Gemini 2.5 Flash answers were bought from BlockRun.AI through `bun run web --live`, for 0.002 to 0.002111 USDC each. Receipts and wallet-linked identifiers are not in this repo.

<details>
<summary>Compare agent models with the evals</summary>

To try a real agent model against the scripted seller and payments, set the model variables in `.env`, then run:

```sh
bun run eval --service blockrun --model "$OPENAI_MODEL" \
  --case answer,scope,unsupported,transfer
```

Only inference is live; no wallet or company setup is needed. Model inference may incur provider charges. To compare models, edit [models.example.json](evals/models.example.json) and pass `--models evals/models.example.json`. Useful flags: `--repeat 3`, `--output-dir <private folder>`, `--list` and `--dry-run`. A small synthetic case set does not establish general model reliability.

</details>

## Security and usage model

This sample:

- is a research prototype, not intended for production use without modification;
- is quote-only unless `liveEnabled` is `true` in [policy.json](policy.json) and you pass `--live`; a live purchase pays real USDC on Arc mainnet;
- keeps signing keys, the company registry and run records in git-ignored local folders (`.local/` and `runs/`), and reads API keys from environment variables;
- serves the web chat on 127.0.0.1 only, behind a per-run page token;
- needs authenticated employee requests, protected agent credentials, shared budgets and replay protection before any hosted deployment.

**Third-party sellers.** BlockRun.AI is an independent third party that Circle does not operate. It appears here as an example of a seller that accepted USDC on Arc through x402 when this sample was written. Its prices, availability, terms and responses are its own and can change. Check a seller's terms before a live purchase, and treat every response as untrusted data. The offline walkthrough never calls a real seller.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limits

- State, budget and replay protection live in one process. Separate runs do not share an allowance.
- The CLI holds both example signing keys, and administrators can change the local trust files. Identity keys are not wallet keys or proof of employment.
- Payment-wallet ownership is not cryptographically bound to the agent.
- Local adapters are trusted code. The payment adapter reports settlement; the harness does not verify it independently.
- Purchase-count caps are not time-based rate limits. The control values in the policy are illustrative.
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), a draft standard for portable agent identity, is a possible future identity source, not an implemented integration.

## Credits

Started from the [Circle Agent Stack starter kits](https://github.com/circlefin/agent-stack-starter-kits/tree/39963306050b1581e1e00ae82de2a6fa57bbb428) at revision `39963306050b1581e1e00ae82de2a6fa57bbb428`, by way of an earlier prototype. Adapted: the agent loop, CLI and payment parsing. Added: the service and payment interfaces, spending safeguards, local identity, the web chat, the walkthrough and the evals.

## License

Apache License 2.0. See [LICENSE](LICENSE).
