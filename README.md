# jev-tool-permissions

An agent tool-permissions layer for the [Vercel AI SDK](https://ai-sdk.dev), backed by the
[`typesafe-ai/jev`](https://www.npmjs.com/package/typesafe-ai) evaluation model via the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

It does two jobs:

1. **Pre-flight approval gate** — before a tool call executes, decide `auto-approve` / `ask-human` / `block`.
2. **Tool-list pruning** — before a turn, drop tool definitions that are irrelevant to the current task, to
   save context tokens. Agents commonly carry 50–200 MCP tool definitions, costing thousands of tokens
   every single turn whether or not they're used.

Both sit on top of a **deterministic floor** of allow/deny rules that runs first and never calls the model,
and both are **fail-closed**: if the Jev call errors or times out, the approval gate defaults to
`ask-human`, never `auto-approve`.

## Why Jev, not an LLM judge

An approval gate has to run on *every single tool call*, on the critical path, before the call executes.
That rules out a general-purpose LLM-as-judge:

- **Speed.** Jev is a small evaluation model built to answer structured yes/no, choice and score questions,
  not to write prose. It's built for exactly this call shape — batching multiple questions about one shared
  state into a single fast round trip — rather than a chat completion you have to prompt-engineer into
  emitting parseable JSON.
- **Cost.** Jev prices input tokens at roughly $0.04/1M. Routing every tool call through a frontier chat
  model to get a risk judgement would be many times more expensive than the tool call it's gating, and
  would dominate the cost of running the agent at all.
- **Shape.** Jev's `evaluate()` API returns typed, probabilistic answers (`{ probability }`,
  `{ score }`, `{ choice, probabilities }`) instead of free text, so the gate's threshold logic can be
  simple, deterministic arithmetic on numbers the model actually committed to — no output parsing, no
  regexing a decision out of a paragraph.

A slower, smarter judge model still has a place — as an escalation path *after* `ask-human`, or for
periodic audits of the gate's own decisions — but it does not belong in the hot path of every tool call.

## Install

```sh
npm install jev-tool-permissions ai
```

`ai` (`^7.0.105`) is a peer dependency — this package brings no other runtime dependencies.

## Authentication

This package does **not** implement authentication itself. `experimental_evaluate` (like the rest of the
AI SDK's AI Gateway integration) reads credentials from the environment:

- **`AI_GATEWAY_API_KEY`** — a Vercel AI Gateway API key. Simplest option outside of Vercel.
- **`VERCEL_OIDC_TOKEN`** — a short-lived (~12h) OIDC token, used automatically when running inside a
  Vercel project. Refresh it locally with `vercel env pull`.

If you're using the default model id (the string `'typesafe-ai/jev'`, which resolves through the Gateway)
and neither variable is set, `createPermissionGate`/`pruneTools` fail fast with a clear `JevAuthError`
instead of letting a confusing 401 surface from inside `evaluate()` — and because the whole package is
fail-closed, that error becomes an `ask-human` decision (or, for pruning, "keep everything"), never a
silent bypass. If you pass your own `EvaluationModel` instance instead of the default string id, this
check is skipped — you're assumed to have wired up your own auth for it.

## API

### The deterministic floor

Both the approval gate and the pruner sit on top of the same rule mechanism, modeled on how
[`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction) uses "pinning" to keep
certain decisions out of the probabilistic layer entirely:

```ts
type RuleSpec =
  | string                                          // glob: '*' any run of chars, '?' any one char
  | RegExp
  | ((toolName: string, input?: unknown) => boolean); // predicate over the call's arguments
```

- **`deny`** rules are checked first. A match blocks the call immediately — **no API call is made**.
- **`allow`** rules are checked next. A match auto-approves immediately — **no API call is made**.
- If neither matches, the call falls through to Jev.
- Deny always wins over allow for the same tool: the deterministic floor is a safety net, not a set of
  competing opinions.

### `createPermissionGate`

```ts
import { createPermissionGate } from 'jev-tool-permissions';

const gate = createPermissionGate({
  policy: {
    deny: ['*delete*', '*.destroy*', /^dangerous/i],
    allow: ['read*', 'list*'],
    thresholds: { autoApprove: 0.95, block: 0.6 }, // see "Threshold asymmetry" below
    onError: 'ask-human',   // 'block' is also legal; 'auto-approve' is not a valid value, on purpose
    model: 'typesafe-ai/jev', // default; pass an EvaluationModel instance to use your own
    timeoutMs: 5000,          // optional — abort the Jev call and fail closed after this long
    maxRetries: 2,            // passed straight through to evaluate()
  },
});

const decision = await gate.check({
  tool: { name: 'deleteRecord', input: { id: 42 }, description: 'Deletes a record by id' },
  task: 'clean up the duplicate rows the user pointed out',
  history: [/* optional prior steps, passed through as context */],
});

// decision: {
//   decision: 'auto-approve' | 'ask-human' | 'block',
//   reversible: number,   // P(the call's effects are reversible / low-stakes), in [0, 1]
//   inScope: number,      // P(the call is a reasonable step toward the stated task), in [0, 1]
//   risk: number,         // risk score in [0, 1], 0 = minimal, 1 = severe
//   reason: 'deny-rule' | 'allow-rule' | 'threshold' | 'error',
//   usage: { inputTokens, outputTokens, totalTokens } | undefined, // undefined when a rule short-circuited
//   ms: number,
//   error?: unknown,      // set when reason === 'error'
// }
```

When no rule decides the call, `check()` asks Jev exactly **three** questions about the call — reversible
(boolean), in-scope (boolean) and risk (5-level score) — in a **single `evaluate()` round trip** against
one shared `state` (the task, the tool call, and any history you pass in). It then computes:

```
safety   = (1 - risk) * reversible * inScope
decision = risk >= thresholds.block      ? 'block'
         : safety >= thresholds.autoApprove ? 'auto-approve'
         : 'ask-human'
```

### Threshold asymmetry

The two thresholds are **not** both 0.5, and they are not symmetric, because the two kinds of mistake
this gate can make have wildly different costs:

- **Auto-approving a call that should have been blocked** can mean deleted data, sent messages, spent
  money, or an irreversible external side effect — potentially catastrophic, and not undoable after the
  fact.
- **Escalating a call that was actually safe** costs a human one extra click.

So the bar to *skip* the human (`autoApprove`, default **0.95**) is deliberately very high — the `safety`
score is a *product* of three probabilities, so every one of "not risky", "reversible" and "on-task" has
to be simultaneously near-certain before the gate lets a call through unattended. Meanwhile the bar to
*hard-block* (`block`, default **0.6**) is deliberately lower — a call doesn't need to look certain to be
destructive before we'd rather a human looked at it than let it through. The gap between the two
thresholds is the "ask a human" zone, which is the safe, cheap default outcome for anything in between.

Both are configurable per gate via `policy.thresholds`, because what counts as "destructive" is
domain-specific — a gate in front of a sandboxed code-execution tool and one in front of a production
database admin tool should not share the same bar.

### `pruneTools`

```ts
import { pruneTools } from 'jev-tool-permissions';

const { tools, dropped, relevance, savedTokens, usage } = await pruneTools({
  tools: allTools,        // Record<string, Tool> — the same shape as AI SDK's ToolSet
  task: 'find last month\'s invoices and email them to finance',
  policy: {
    deny: ['debug*'],      // always dropped, never asked about
    allow: ['search*'],    // always kept, never asked about
    thresholds: { keep: 0.2 }, // see below
  },
});

// tools:      the pruned Record<string, Tool> — same shape as the input, pass it straight to streamText
// dropped:    string[] of tool names removed
// relevance:  Record<string, number> — P(relevant) for each tool that went through Jev
// savedTokens: rough estimate of input tokens saved by dropping `dropped`, based on serialized size
```

However many tools are under consideration, `pruneTools` makes **exactly one** `evaluate()` call: every
tool not already decided by a rule gets its own boolean "is this relevant to the task" question, and all
of them are answered together against one shared `state` (`{ task, history }`). This is the same batching
principle as the approval gate, just fanned out over tools instead of over questions about one tool.

The keep threshold defaults to a low **0.2** — deliberately the opposite asymmetry from the approval gate.
Wrongly dropping a tool the agent actually needs breaks its turn; wrongly keeping an irrelevant one costs
a few hundred tokens. So pruning only removes tools Jev is fairly confident are unneeded, and on error it
**fails open** (`onError: 'keep-all'`, the only — and default — option): a failed prune should cost you the
token savings for that turn, not the agent's ability to do its job.

### AI SDK integration

Three helpers wire the above into real AI SDK 7 primitives (verified against the installed `ai@7.0.105`
package's type declarations):

```ts
import { streamText } from 'ai';
import {
  createPermissionGate,
  createToolApproval,
  createPruningPrepareStep,
  extractTaskFromMessages,
} from 'jev-tool-permissions';

const gate = createPermissionGate({ policy: { deny: ['*delete*'] } });

const result = streamText({
  model: 'openai/gpt-5',
  tools: allTools,

  // Approval gate -> the AI SDK's native per-tool-call approval mechanism.
  // Each decision maps to 'approved' | 'user-approval' | 'denied'.
  toolApproval: createToolApproval(gate, { getTask: extractTaskFromMessages }),

  // Tool-list pruning -> a `prepareStep` that computes `activeTools` once,
  // before the first model call, from the task in the conversation.
  prepareStep: createPruningPrepareStep({
    tools: allTools,
    getTask: extractTaskFromMessages,
  }),
});
```

`createPruningPrepareStep` returns a real `PrepareStepFunction`: it calls `pruneTools` once (by default,
only on `stepNumber === 0` — pruning is a per-turn decision about what the task needs, not a per-step one)
and returns `{ activeTools }`, which the AI SDK itself narrows the tool list by for that call.

For cases outside the `generateText`/`streamText` step loop — a one-off call, or just wanting the trimmed
tool set as a value to inspect or log — `filterToolsForTask` does the same pruning and then applies it with
the AI SDK's own `experimental_filterActiveTools`, so what you get back is a real subset of the tools you
passed in, not a re-derived object:

```ts
import { generateObject } from 'ai';
import { filterToolsForTask } from 'jev-tool-permissions';

const { tools, dropped, savedTokens } = await filterToolsForTask({
  tools: allTools,
  task: userRequest,
});

await generateObject({ model, tools, schema, prompt: userRequest });
```

`createToolApproval` is built on the AI SDK's `toolApproval` option (a `GenericToolApprovalFunction`) —
the AI SDK's own mechanism for "does this specific tool call need a human", which maps naturally onto the
gate's three decisions. This is a deliberate choice beyond what was asked for two independent helpers for
`prepareStep`/`filterActiveTools`: `prepareStep`/`filterActiveTools` govern *which tools the model can see*
(pruning), while `toolApproval` governs *whether a specific call the model already made gets to run*
(the gate) — they're different questions, wired to different AI SDK hooks.

### How `safety` is computed

```
risk     = answers.risk.score / (levels - 1)     // normalized to [0,1]
safety   = min(1 - risk, reversible, inScope)    // weakest link
```

`safety` is the **minimum** of the three dimensions, not their product. A product of
three probabilities is systematically low — three independently excellent dimensions at
`0.98` multiply to `0.94`, which sits below a `0.95` bar — so a product makes
`auto-approve` effectively unreachable and routes every call to a human, defeating the
gate. With `min`, the threshold reads literally: *every* dimension must be at least that
confident. `block` is checked first and independently, against `risk` alone, so a
high-risk call is blocked no matter how good the other two dimensions look.

### A note on glob patterns

`*` matches any run of characters and `?` any single character; everything else is
literal. `*.delete*` requires a literal dot, so it matches `db.deleteUser` but **not**
`deleteRecord`. When in doubt use `*delete*`, and assert your policy in a test — a deny
rule that silently matches nothing looks identical to one that works.

## Design notes / deviations from the suggested API

- **`ToolsInput` is `Record<string, Tool>`, not an array.** The brief's sketch (`{ tools: allTools }`)
  didn't pin down the shape. This package matches AI SDK's own `ToolSet` type exactly (`Record<string,
  Tool>` keyed by name), so `pruneTools`'s output plugs directly into `streamText({ tools })` and into
  `experimental_filterActiveTools`'s `activeTools` (an array of those keys) without any reshaping.
- **`reason` has a fourth value, `'allow-rule'`,** distinct from `'deny-rule'` — the brief's example listed
  only `'deny-rule' | 'threshold' | 'error'`. Collapsing "auto-approved by rule" into `'threshold'` would
  have hidden a fact worth logging: this decision never touched the model at all.
- **`onError` for the gate excludes `'auto-approve'` at the type level**, not just in the default — the
  brief asked to "make this configurable but default safe"; making the unsafe value inexpressible seemed
  strictly better than making it merely non-default.
- **`toolApproval` wiring (`createToolApproval`)** is additional beyond the requested `prepareStep` /
  `filterActiveTools` helpers, for the reason described above.

## Engineering

- TypeScript, ESM, strict mode; `ai` as the only dependency (peer only — no runtime dependencies of its
  own).
- Built with `tsup` → ESM output + `.d.ts` in `dist/`.
- Tests (`vitest`) mock `experimental_evaluate` at the module boundary — there is no network access to
  `ai-gateway.vercel.sh` in CI or in this environment, so nothing here makes a live call.

```sh
npm install
npm run typecheck
npm run build
npm run test
```
