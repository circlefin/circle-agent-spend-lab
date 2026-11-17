# Working on Circle Agent Spend Lab

This is a small reusable USDC spending harness. Its one seller is BlockRun.AI (AI model answers), paid on Arc. The offline walkthrough, evals and tests use a scripted BlockRun.AI (evals/fixtures/blockrun.json): scripted quotes, answers and payments, no network calls. services/_template is a generic example for adding a seller. Start with README.md. Do not add private material, credentials or execution records to Git.

- Use invented, neutral examples. Never derive example locations, names, accounts, paths or prompts from the user's session context, profile, memory or private workspace. Exclude personal wallet addresses and wallet-linked transaction identifiers from shareable source. Keep original private evidence outside the repository. Do not send private context in evaluation requests.

- Before finishing, run what CI runs: `bun run check`, `bun run demo` and `bun run eval --service blockrun --offline`. Update the Testing table in README.md when counts change.
- Default the app to quote-only. Use tests and offline evals for verification; never run live purchases, funding or wallet-policy changes as tests.
- Live verification requires explicit user authorization and a bounded run policy. Keep original live evidence outside the repository; use the eval command's --output-dir for a private destination. README examples must distinguish real payments, real model inference and synthetic seller effects.
- Keep test data under evals/. The live app and service loader must not depend on it.
- policy.json lists only sellers that are live and paid on Arc. Offline fixture sellers (the scripted BlockRun.AI and the template) belong in evals/offline-policy.json.
- Every BlockRun.AI request starts with the company's fixed system message from services/blockrun/adapter.ts. The agent writes only the user prompt; do not let it drop or replace that message.
- Keep seller-specific behaviour in its service folder. Named operations, buyer authority, budgets, approval and payment execution belong to the shared harness.
- Keep the main example local: ExampleCo assigns an employee to its approved research agent and separately funds its operating wallet. The offline demo uses real local signatures with scripted model, seller and payment effects. No funding tool belongs in the model's tools.
- Every harness needs a signed identity session. Verify company membership, agent status, employee assignment, service permission and task/service/policy binding before model use and purchases. Recheck after asynchronous waits. Keep identity keys outside model context and records. Do not add a production bypass for tests; use synthetic signed identities.
- Company configuration is trusted local administration, not enterprise authentication. Do not describe local credentials as SSO, employment verification, wallet identity or ERC-8004 integration. Preserve process-local budget/replay and audit limits.
- Keep payment integrations under payments/. Load only the explicitly selected adapter through src/payment.ts. Do not add Circle imports, wallet configuration or authentication checks to the shared core.
- Keep service instructions in service.json. The README covers setup, architecture, commands, adaptation and limits.
- Do not give service adapters an independent payment function or add an unrestricted shell tool to the agent.
- Do not describe scripted model tests as empirical model benchmarks.
- SAFR (Safeguards for Agentic Finance at Runtime) terms appear only as an exploration: src/safr.ts and the README section "How this sample app explores SAFR". Keep the page, the records and the README in step. Do not describe this sample as implementing, certified under, compliant with or endorsed by SAFR or any other framework.
- Show example prompts, observed responses and pass/fail tables. Preserve failures and report the run date, model IDs, trial count and evaluation limits. Keep writing short and concrete.
- State the question each model comparison tests and justify candidate selection. Use the same frozen cases and grading across candidates, repeat trials, record API mode and output limits, and separate answer checks from tool effects and formatting. Treat endpoint errors as errors, not evidence that a model is poor. Do not infer general model rankings from a small synthetic case set.
- Write prompts as ordinary user requests. Inject price, approval and payment failures through eval fixtures. Keep scripted concurrency probes separate from model comparisons. An allowed purchase can still be irrelevant to the request; do not call that a policy violation unless a policy rule was violated.
- Preserve the upstream attribution in README.md and applicable licence notices. No em dashes in documentation or comments.

This file guides coding assistants working on the repo. The application does not load it as spending authority; runtime policy is enforced by code.
