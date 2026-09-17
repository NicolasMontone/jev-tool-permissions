import type {
  Experimental_EvaluationModel as EvaluationModel,
  Experimental_EvaluationResult as EvaluationResult,
  Experimental_EvaluationQuestion as EvaluationQuestion,
} from 'ai';

/**
 * A rule used by the deterministic floor (see `rules.ts`).
 *
 * - `string` — a glob pattern matched against the tool name (`*` = any run of
 *   characters, `?` = any single character). Matching is case-sensitive.
 * - `RegExp` — tested against the tool name.
 * - `function` — a predicate given the tool name and (optionally) its input,
 *   for rules that depend on call arguments (e.g. "deny `writeFile` only when
 *   `input.path` escapes the project directory").
 */
export type RuleSpec =
  | string
  | RegExp
  | ((toolName: string, input?: unknown) => boolean);

/** Usage/cost accounting surfaced from a Jev `evaluate()` call. */
export type JevUsage = EvaluationResult<Record<string, EvaluationQuestion>>['usage'];

/** What happens when the Jev call itself fails (network error, timeout, bad response, auth). */
export type OnErrorBehavior = 'ask-human' | 'block';

/** Asymmetric decision thresholds. See README "Threshold asymmetry" for the rationale. */
export interface ThresholdConfig {
  /**
   * Minimum composite safety confidence, in [0, 1], required to auto-approve
   * a tool call without a human in the loop. Safety is computed as
   * `(1 - risk) * reversibility * inScope`, so this number is deliberately a
   * high bar (default `0.95`): every one of "not risky", "reversible", and
   * "on-task" has to be simultaneously confident before we skip the human.
   */
  autoApprove: number;
  /**
   * Minimum risk score, in [0, 1], at which a call is blocked outright
   * rather than escalated to a human. This is deliberately a *lower* bar
   * than `autoApprove` (default `0.6`) — the cost of wrongly escalating a
   * merely-risky call is a human clicking "approve"; the cost of wrongly
   * auto-approving a destructive one is data loss. We ask more to let
   * something through than we ask to keep it out.
   */
  block: number;
}

/** The tool a permission decision is being made about. */
export interface ToolDescriptor {
  name: string;
  /** The arguments the model wants to call the tool with, if known. */
  input?: unknown;
  /** Human-readable description of what the tool does, as given to the model. */
  description?: string;
}

/** One prior step in the current agent run, for context. Shape is intentionally loose. */
export type HistoryEntry = unknown;

export type Decision = 'auto-approve' | 'ask-human' | 'block';

export type DecisionReason =
  | 'deny-rule'
  | 'allow-rule'
  | 'threshold'
  | 'error';

export interface CheckInput {
  tool: ToolDescriptor;
  /** The user request / current goal the agent is pursuing. */
  task: string;
  /** Optional prior steps, passed through to Jev as shared state for context. */
  history?: HistoryEntry[];
  abortSignal?: AbortSignal;
}

export interface CheckResult {
  decision: Decision;
  /** P(this call's effects are reversible / non-destructive), in [0, 1]. 1 when short-circuited by an allow-rule. */
  reversible: number;
  /** P(this call is in scope of the stated task), in [0, 1]. 1 when short-circuited by an allow-rule. */
  inScope: number;
  /** Risk score, in [0, 1], 0 = minimal risk, 1 = severe. 0 when short-circuited by an allow-rule, 1 when short-circuited by a deny-rule. */
  risk: number;
  reason: DecisionReason;
  /** Token usage for the Jev call. `undefined` when short-circuited by a rule (no API call was made). */
  usage: JevUsage | undefined;
  /** Wall-clock time for the check, in milliseconds. */
  ms: number;
  /** The error that caused a fail-closed decision, if `reason === 'error'`. */
  error?: unknown;
}

export interface PermissionPolicy {
  /** Deterministic deny rules. Checked first; a match blocks with no API call. */
  deny?: RuleSpec[];
  /** Deterministic allow rules. Checked after deny; a match auto-approves with no API call. */
  allow?: RuleSpec[];
  thresholds?: Partial<ThresholdConfig>;
  /** What to do when the Jev call errors or times out. Default `'ask-human'`. `'auto-approve'` is not a legal value here on purpose. */
  onError?: OnErrorBehavior;
  /** Evaluation model to use. Defaults to the string id `'typesafe-ai/jev'` (resolved via AI Gateway). */
  model?: EvaluationModel;
  /** Abort the Jev call after this many milliseconds and fail closed. Default: no timeout beyond `evaluate`'s own retries. */
  timeoutMs?: number;
  /** Max retries passed through to `evaluate`. Defaults to the AI SDK's own default (2). */
  maxRetries?: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  autoApprove: 0.95,
  block: 0.6,
};

export const DEFAULT_MODEL: EvaluationModel = 'typesafe-ai/jev';

export const DEFAULT_ON_ERROR: OnErrorBehavior = 'ask-human';

// ---- Pruning ----------------------------------------------------------

/** Minimal shape pruning needs from a tool definition; AI SDK `Tool`/`ToolSet` entries satisfy this. */
export interface PrunableTool {
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  [key: string]: unknown;
}

export type ToolsInput = Record<string, PrunableTool>;

export interface PruneThresholds {
  /**
   * Minimum P(this tool is relevant to the task), in [0, 1], required to
   * keep a tool. Default `0.2` — deliberately low, the asymmetry runs the
   * other way here: wrongly dropping a tool the agent actually needs is far
   * more costly (a broken turn) than wrongly keeping an irrelevant one (a
   * few hundred wasted tokens), so pruning only removes tools Jev is fairly
   * confident are unneeded.
   */
  keep: number;
}

export const DEFAULT_PRUNE_THRESHOLDS: PruneThresholds = {
  keep: 0.2,
};

export interface PrunePolicy {
  /** Deterministic deny rules — matching tools are always dropped, no API call for them. */
  deny?: RuleSpec[];
  /** Deterministic allow rules — matching tools are always kept, no API call for them. */
  allow?: RuleSpec[];
  thresholds?: Partial<PruneThresholds>;
  /**
   * What to do if the Jev call errors. `'keep-all'` (the only option, and
   * the default) keeps every tool not matched by an explicit deny rule:
   * pruning failure should not break the agent's turn, it should just
   * forgo the token savings for that turn. Unlike the approval gate, there
   * is no destructive-side failure mode here to fail closed against.
   */
  onError?: 'keep-all';
  model?: EvaluationModel;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface PruneInput<T extends ToolsInput> {
  tools: T;
  /** The user request / current goal the agent is pursuing. */
  task: string;
  history?: HistoryEntry[];
  policy?: PrunePolicy;
  abortSignal?: AbortSignal;
}

export interface PruneResult<T extends ToolsInput> {
  /** The pruned tool set, same shape as the input, safe to pass straight to `streamText`/`generateText`. */
  tools: T;
  /** Names of tools that were dropped. */
  dropped: string[];
  /** Per-tool relevance probability, for tools that went through Jev (rule-decided tools are omitted). */
  relevance: Record<string, number>;
  /** Rough estimate of input tokens saved by dropping tools, based on serialized definition size. Approximate. */
  savedTokens: number;
  usage: JevUsage | undefined;
  ms: number;
  error?: unknown;
}
