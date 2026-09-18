import { experimental_evaluate as evaluate } from 'ai';
import type { Experimental_EvaluationQuestion as EvaluationQuestion } from 'ai';
import { evaluateDeterministic } from './rules.js';
import { assertGatewayAuthConfigured } from './errors.js';
import {
  DEFAULT_MODEL,
  DEFAULT_ON_ERROR,
  DEFAULT_THRESHOLDS,
  type CheckInput,
  type CheckResult,
  type PermissionPolicy,
  type ThresholdConfig,
} from './types.js';

const RISK_LEVELS = [
  "Minimal risk: read-only or fully sandboxed, no effects outside the tool's own scratch space.",
  'Low risk: a minor, easily-reversible external effect (e.g. a draft, a reversible toggle).',
  'Moderate risk: a real external effect, but bounded in scope and plausibly intended by the task.',
  'High risk: a broad or hard-to-reverse effect (bulk delete/update, a financial transaction, sending communications).',
  'Severe risk: destructive, irreversible, or far outside the tool\'s apparent intended use (e.g. deleting production data, transferring large sums, exfiltrating secrets).',
] as const;

function buildQuestions() {
  return {
    reversible: {
      type: 'boolean',
      instructions:
        'Given the tool call and task described in state, is this specific call reversible or otherwise low-stakes if it turns out to have been a mistake? ' +
        'Answer false for actions with a lasting real-world effect (sending messages, deleting or overwriting data, spending money, modifying external systems) that cannot be trivially undone.',
      criteria: {
        true: 'The call is read-only, idempotent, or its effects can be trivially undone (draft, dry-run, reversible toggle, sandboxed).',
        false: 'The call has a lasting, hard-to-undo effect if it executes (delete, send, pay, publish, modify external state).',
      },
    },
    inScope: {
      type: 'boolean',
      instructions:
        'Given the tool call, task, and history described in state, is this call a reasonable, on-task step toward the stated goal? ' +
        'Answer false if the call is unrelated to the task, or requests materially more or broader access than the task requires.',
      criteria: {
        true: 'A reasonable, on-task step given the stated goal and prior history.',
        false: 'Unrelated to the task, or exceeds what the task requires.',
      },
    },
    risk: {
      type: 'score',
      instructions:
        'Given the tool call and task described in state, how risky would it be to execute this call automatically, with no human reviewing it first? ' +
        "Consider blast radius, reversibility, and whether the call's input looks like it could cause data loss, financial loss, security exposure, or irreversible external effects.",
      criteria: [...RISK_LEVELS],
    },
  } satisfies Record<'reversible' | 'inScope' | 'risk', EvaluationQuestion>;
}

function normalizeThresholds(thresholds: Partial<ThresholdConfig> | undefined): ThresholdConfig {
  return { ...DEFAULT_THRESHOLDS, ...thresholds };
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!timeoutMs) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Jev call timed out after ${timeoutMs}ms`)), timeoutMs);
  const onExternalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onExternalAbort);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

export interface PermissionGate {
  policy: Required<Pick<PermissionPolicy, 'deny' | 'allow' | 'onError'>> &
    Pick<PermissionPolicy, 'model' | 'timeoutMs' | 'maxRetries'> & { thresholds: ThresholdConfig };
  check(input: CheckInput): Promise<CheckResult>;
}

export function createPermissionGate(options: { policy?: PermissionPolicy } = {}): PermissionGate {
  const policy = options.policy ?? {};
  const deny = policy.deny ?? [];
  const allow = policy.allow ?? [];
  const thresholds = normalizeThresholds(policy.thresholds);
  const onError = policy.onError ?? DEFAULT_ON_ERROR;
  const model = policy.model ?? DEFAULT_MODEL;

  async function check(input: CheckInput): Promise<CheckResult> {
    const start = Date.now();
    const { tool, task, history, abortSignal } = input;

    // --- Deterministic floor: no API call, no probabilistic uncertainty. ---
    const verdict = evaluateDeterministic(tool.name, tool.input, deny, allow);
    if (verdict === 'deny') {
      return {
        decision: 'block',
        reversible: 0,
        inScope: 0,
        risk: 1,
        reason: 'deny-rule',
        usage: undefined,
        ms: Date.now() - start,
      };
    }
    if (verdict === 'allow') {
      return {
        decision: 'auto-approve',
        reversible: 1,
        inScope: 1,
        risk: 0,
        reason: 'allow-rule',
        usage: undefined,
        ms: Date.now() - start,
      };
    }

    // --- Probabilistic layer: one round trip, three questions. ---
    const { signal, cleanup } = withTimeout(abortSignal, policy.timeoutMs);
    try {
      assertGatewayAuthConfigured(model);

      // `tool.input`/`history` are caller-supplied and typed `unknown` — Jev requires
      // JSON-serializable state, which we can't verify statically for arbitrary input.
      const state = {
        task,
        tool: {
          name: tool.name,
          description: tool.description ?? null,
          input: tool.input ?? null,
        },
        history: history ?? [],
      } as Parameters<typeof evaluate>[0]['state'];

      const result = await evaluate({
        model,
        state,
        questions: buildQuestions(),
        abortSignal: signal,
        ...(policy.maxRetries !== undefined ? { maxRetries: policy.maxRetries } : {}),
      });

      const reversible = result.answers.reversible.probability;
      const inScope = result.answers.inScope.probability;
      const riskLevels = RISK_LEVELS.length;
      const risk = result.answers.risk.score / (riskLevels - 1);

      // Weakest-link, not a product. A product of three probabilities is
      // systematically low — three independently excellent dimensions at 0.98
      // each multiply to 0.94, below a 0.95 bar — so a product makes
      // auto-approve effectively unreachable and pushes every call to a human,
      // which defeats the gate. `min` means the threshold reads literally:
      // "every dimension must be at least this confident".
      const safety = Math.min(1 - risk, reversible, inScope);

      let decision: CheckResult['decision'];
      if (risk >= thresholds.block) {
        decision = 'block';
      } else if (safety >= thresholds.autoApprove) {
        decision = 'auto-approve';
      } else {
        decision = 'ask-human';
      }

      return {
        decision,
        reversible,
        inScope,
        risk,
        reason: 'threshold',
        usage: result.usage,
        ms: Date.now() - start,
      };
    } catch (error) {
      return {
        decision: onError,
        reversible: 0,
        inScope: 0,
        risk: 1,
        reason: 'error',
        usage: undefined,
        ms: Date.now() - start,
        error,
      };
    } finally {
      cleanup();
    }
  }

  return {
    policy: { deny, allow, thresholds, onError, model, timeoutMs: policy.timeoutMs, maxRetries: policy.maxRetries },
    check,
  };
}
