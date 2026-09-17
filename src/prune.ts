import { experimental_evaluate as evaluate } from 'ai';
import type { Experimental_EvaluationQuestion as EvaluationQuestion } from 'ai';
import { evaluateDeterministic } from './rules.js';

/** Narrowed to the boolean-question shape so answers are typed with `.probability`, not the full union. */
type BooleanQuestion = Extract<EvaluationQuestion, { type: 'boolean' }>;
import { assertGatewayAuthConfigured } from './errors.js';
import {
  DEFAULT_MODEL,
  DEFAULT_PRUNE_THRESHOLDS,
  type PruneInput,
  type PruneResult,
  type PruneThresholds,
  type ToolsInput,
} from './types.js';

function normalizeThresholds(thresholds: Partial<PruneThresholds> | undefined): PruneThresholds {
  return { ...DEFAULT_PRUNE_THRESHOLDS, ...thresholds };
}

/** Rough token estimate for a serialized value. Approximate (chars/4); good enough to size savings, not for billing. */
function estimateTokens(value: unknown): number {
  try {
    const length = JSON.stringify(value)?.length ?? 0;
    return Math.ceil(length / 4);
  } catch {
    return 0;
  }
}

function toolDefinitionForSizing(name: string, tool: { description?: string; inputSchema?: unknown; parameters?: unknown }) {
  return {
    name,
    description: tool.description,
    schema: tool.inputSchema ?? tool.parameters,
  };
}

/**
 * Prunes a tool set down to the tools relevant to the current task, using
 * exactly ONE `evaluate()` round trip regardless of how many tools are
 * being considered: every remaining (non-rule-decided) tool gets its own
 * boolean "is this relevant" question, all answered together against one
 * shared task/history state.
 */
export async function pruneTools<T extends ToolsInput>(input: PruneInput<T>): Promise<PruneResult<T>> {
  const start = Date.now();
  const { tools, task, history, abortSignal } = input;
  const policy = input.policy ?? {};
  const deny = policy.deny ?? [];
  const allow = policy.allow ?? [];
  const thresholds = normalizeThresholds(policy.thresholds);
  const model = policy.model ?? DEFAULT_MODEL;

  const names = Object.keys(tools);

  const denied = new Set<string>();
  const kept = new Set<string>();
  const pending: string[] = [];

  for (const name of names) {
    const verdict = evaluateDeterministic(name, undefined, deny, allow);
    if (verdict === 'deny') denied.add(name);
    else if (verdict === 'allow') kept.add(name);
    else pending.push(name);
  }

  let relevance: Record<string, number> = {};
  let usage: PruneResult<T>['usage'] = undefined;
  let error: unknown;

  if (pending.length > 0) {
    try {
      assertGatewayAuthConfigured(model);

      const questions: Record<string, BooleanQuestion> = {};
      for (const name of pending) {
        const tool = tools[name]!;
        questions[name] = {
          type: 'boolean',
          instructions:
            `Tool "${name}": ${tool.description ?? '(no description provided)'}\n\n` +
            'Given the task (and any history) described in state, is this tool likely to be needed to accomplish it? ' +
            'Answer true generously for tools that plausibly help; answer false only for tools clearly unrelated to the task.',
          criteria: {
            true: 'This tool is plausibly useful for accomplishing the stated task.',
            false: 'This tool is unrelated to the stated task.',
          },
        };
      }

      // `history` is caller-supplied and typed `unknown` — Jev requires JSON-serializable
      // state, which we can't verify statically for arbitrary input.
      const state = { task, history: history ?? [] } as Parameters<typeof evaluate>[0]['state'];

      const result = await evaluate({
        model,
        state,
        questions,
        abortSignal,
        ...(policy.maxRetries !== undefined ? { maxRetries: policy.maxRetries } : {}),
      });

      usage = result.usage;
      for (const name of pending) {
        const probability = result.answers[name]!.probability;
        relevance[name] = probability;
        if (probability >= thresholds.keep) {
          kept.add(name);
        } else {
          denied.add(name);
        }
      }
    } catch (err) {
      error = err;
      // Fail open for pruning: keep everything we hadn't already ruled out.
      for (const name of pending) kept.add(name);
    }
  }

  const prunedEntries = names.filter((name) => kept.has(name)).map((name) => [name, tools[name]!] as const);
  const prunedTools = Object.fromEntries(prunedEntries) as T;
  const dropped = names.filter((name) => denied.has(name));

  const savedTokens = dropped.reduce(
    (sum, name) => sum + estimateTokens(toolDefinitionForSizing(name, tools[name]!)),
    0,
  );

  return {
    tools: prunedTools,
    dropped,
    relevance,
    savedTokens,
    usage,
    ms: Date.now() - start,
    ...(error !== undefined ? { error } : {}),
  };
}
