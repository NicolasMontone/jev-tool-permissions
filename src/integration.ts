import { experimental_filterActiveTools as filterActiveTools } from 'ai';
import type {
  GenericToolApprovalFunction,
  ModelMessage,
  PrepareStepFunction,
  ToolSet,
} from 'ai';
import { pruneTools } from './prune.js';
import type { CheckInput, PrunePolicy, ToolsInput } from './types.js';
import type { PermissionGate } from './gate.js';

/**
 * Best-effort extraction of "the task" from a `ModelMessage[]` history: the
 * text of the most recent `user` message. Message content can be a plain
 * string or an array of parts; only text parts are concatenated. Pass your
 * own `getTask` to `createPruningPrepareStep`/`createToolApproval` when this
 * default isn't good enough (e.g. multi-turn tasks that need earlier turns too).
 */
export function extractTaskFromMessages(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const { content } = message;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: 'text'; text: string } => part?.type === 'text')
        .map((part) => part.text)
        .join('\n');
    }
  }
  return '';
}

// ---- Approval gate wiring (toolApproval) -------------------------------

type ApprovalStatusType = 'approved' | 'denied' | 'user-approval';

const DECISION_TO_STATUS: Record<'auto-approve' | 'ask-human' | 'block', ApprovalStatusType> = {
  'auto-approve': 'approved',
  'ask-human': 'user-approval',
  block: 'denied',
};

export interface CreateToolApprovalOptions {
  /** The user request / current goal. Constant for the whole call, or derive it per-call with `getTask`. */
  task?: string;
  /** Overrides `task`: derives it from the messages sent to the model for the step that produced this tool call. */
  getTask?: (messages: ModelMessage[]) => string;
}

/**
 * Wires a `PermissionGate` into the AI SDK's native tool-approval mechanism.
 * Pass the result as `toolApproval` to `generateText`/`streamText`:
 *
 * ```ts
 * const gate = createPermissionGate({ policy: { deny: ['*.delete*'] } });
 * await streamText({
 *   model,
 *   tools,
 *   toolApproval: createToolApproval(gate, { getTask: extractTaskFromMessages }),
 * });
 * ```
 *
 * Each `auto-approve` / `ask-human` / `block` decision from the gate maps to
 * the AI SDK's `'approved' | 'user-approval' | 'denied'` approval statuses,
 * carrying the gate's `reason` through as the human-readable `reason` field.
 */
export function createToolApproval<TOOLS extends ToolSet>(
  gate: PermissionGate,
  options: CreateToolApprovalOptions = {},
): GenericToolApprovalFunction<TOOLS, any, any> {
  return async ({ toolCall, messages }) => {
    const task = options.getTask ? options.getTask(messages) : options.task ?? extractTaskFromMessages(messages);

    const input: CheckInput = {
      tool: {
        name: toolCall.toolName,
        input: toolCall.input,
      },
      task,
    };

    const result = await gate.check(input);

    return {
      type: DECISION_TO_STATUS[result.decision],
      reason: `${result.reason} (risk=${result.risk.toFixed(2)}, reversible=${result.reversible.toFixed(2)}, inScope=${result.inScope.toFixed(2)})`,
    };
  };
}

// ---- Tool-list pruning wiring (prepareStep / filterActiveTools) --------

export interface CreatePruningPrepareStepOptions<T extends ToolsInput> {
  /** The full tool set the model was given. Pruning only ever removes from this set for a given step. */
  tools: T;
  /** The user request / current goal. Constant for the whole call, or derive it per-step with `getTask`. */
  task?: string;
  /** Overrides `task`: derives it from the messages available at each step. */
  getTask?: (messages: ModelMessage[]) => string;
  policy?: PrunePolicy;
  /**
   * Prune once, on the first step, and reuse that tool list for the rest of
   * the run. Default `true` — pruning is a per-turn decision about what the
   * task needs, not a per-step one, and re-running it every step would mean
   * one extra `evaluate()` call per step for no benefit.
   */
  onlyFirstStep?: boolean;
}

/**
 * Builds a `prepareStep` function (for `generateText`/`streamText`) that
 * prunes the tool list to what's relevant to the task before the first
 * model call, returning `{ activeTools }` so the AI SDK filters the tool
 * list it sends to the provider — without ever removing tools from the
 * `tools` object itself, so tool calls the model already made stay valid.
 *
 * ```ts
 * await streamText({
 *   model,
 *   tools: allTools,
 *   prepareStep: createPruningPrepareStep({ tools: allTools, getTask: extractTaskFromMessages }),
 * });
 * ```
 */
export function createPruningPrepareStep<T extends ToolsInput>(
  options: CreatePruningPrepareStepOptions<T>,
): PrepareStepFunction<any, any> {
  let cachedActiveTools: string[] | undefined;

  return async ({ messages, stepNumber }) => {
    const onlyFirstStep = options.onlyFirstStep ?? true;
    if (onlyFirstStep && stepNumber > 0 && cachedActiveTools) {
      return { activeTools: cachedActiveTools };
    }

    const task = options.getTask ? options.getTask(messages) : options.task ?? extractTaskFromMessages(messages);

    const { tools: prunedTools } = await pruneTools({ tools: options.tools, task, policy: options.policy });
    const activeTools = Object.keys(prunedTools);
    cachedActiveTools = activeTools;

    return { activeTools };
  };
}

// ---- One-off pruning outside the step loop -----------------------------

export interface FilterToolsForTaskOptions<T extends ToolsInput> {
  tools: T;
  task: string;
  policy?: PrunePolicy;
}

export interface FilterToolsForTaskResult<T extends ToolsInput> {
  /** The pruned tool set — built via `experimental_filterActiveTools`, so it's a true subset of `tools`, not a re-derived object. */
  tools: T;
  dropped: string[];
  savedTokens: number;
}

/**
 * A non-streaming alternative to `createPruningPrepareStep`: runs
 * `pruneTools` once, then applies the result with the AI SDK's own
 * `experimental_filterActiveTools`, for callers who want the trimmed tool
 * set directly (e.g. to pass as `tools` to a single `generateText` call, or
 * to log/inspect it) rather than plugging into `prepareStep`.
 */
export async function filterToolsForTask<T extends ToolsInput>(
  options: FilterToolsForTaskOptions<T>,
): Promise<FilterToolsForTaskResult<T>> {
  const { tools: prunedTools, dropped, savedTokens } = await pruneTools({
    tools: options.tools,
    task: options.task,
    policy: options.policy,
  });

  const activeTools = Object.keys(prunedTools) as Array<keyof T & string>;
  const filtered = filterActiveTools({ tools: options.tools as unknown as ToolSet, activeTools }) as T;

  return { tools: filtered, dropped, savedTokens };
}
