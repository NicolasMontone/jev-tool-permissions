import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, experimental_evaluate: vi.fn() };
});

import { experimental_evaluate } from 'ai';
import { createPermissionGate } from '../src/gate.js';

const mockEvaluate = vi.mocked(experimental_evaluate);

function boolAnswer(probability: number) {
  return { type: 'boolean' as const, probability };
}

function scoreAnswer(score: number, probabilities?: Record<string, number>) {
  return { type: 'score' as const, score, ...(probabilities ? { probabilities } : {}) };
}

function usage(overrides: Partial<{ inputTokens: number; outputTokens: number; totalTokens: number }> = {}) {
  return { inputTokens: 120, outputTokens: 40, totalTokens: 160, ...overrides };
}

const ENV_KEYS = ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  mockEvaluate.mockReset();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.AI_GATEWAY_API_KEY = 'test-key';
  delete process.env.VERCEL_OIDC_TOKEN;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('createPermissionGate — deterministic floor', () => {
  it('blocks on a deny-rule match without calling evaluate', async () => {
    const gate = createPermissionGate({ policy: { deny: ['*.delete*'] } });

    const result = await gate.check({
      tool: { name: 'db.deleteRecord', input: { id: 1 } },
      task: 'clean up test records',
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toBe('deny-rule');
    expect(result.usage).toBeUndefined();
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('auto-approves on an allow-rule match without calling evaluate', async () => {
    const gate = createPermissionGate({ policy: { allow: ['read*'], deny: ['*.delete*'] } });

    const result = await gate.check({
      tool: { name: 'readFile', input: { path: '/tmp/x' } },
      task: 'summarize a file',
    });

    expect(result.decision).toBe('auto-approve');
    expect(result.reason).toBe('allow-rule');
    expect(result.usage).toBeUndefined();
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('deny takes precedence over allow for the same tool', async () => {
    const gate = createPermissionGate({ policy: { allow: ['deleteFile'], deny: ['deleteFile'] } });

    const result = await gate.check({ tool: { name: 'deleteFile' }, task: 'x' });

    expect(result.decision).toBe('block');
    expect(result.reason).toBe('deny-rule');
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('falls through to the probabilistic layer when no rule matches', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { reversible: boolAnswer(0.9), inScope: boolAnswer(0.9), risk: scoreAnswer(0) },
      usage: usage(),
    } as any);

    const gate = createPermissionGate({ policy: { deny: ['*.delete*'], allow: ['read*'] } });
    const result = await gate.check({ tool: { name: 'sendEmail' }, task: 'notify the team' });

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('threshold');
  });
});

describe('createPermissionGate — one round trip', () => {
  it('answers reversible, inScope and risk in a single evaluate() call', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { reversible: boolAnswer(1), inScope: boolAnswer(1), risk: scoreAnswer(0) },
      usage: usage(),
    } as any);

    const gate = createPermissionGate();
    await gate.check({ tool: { name: 'listFiles' }, task: 'x' });

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    const call = mockEvaluate.mock.calls[0]![0] as any;
    expect(Object.keys(call.questions).sort()).toEqual(['inScope', 'reversible', 'risk']);
    expect(call.questions.risk.type).toBe('score');
    expect(call.questions.reversible.type).toBe('boolean');
    expect(call.questions.inScope.type).toBe('boolean');
  });
});

describe('createPermissionGate — threshold asymmetry', () => {
  it('requires a very high safety confidence to auto-approve, even when everything looks mostly fine', async () => {
    // reversible=0.9, inScope=0.9, risk=0 (minimal) => safety = min(1, 0.9, 0.9) = 0.9 < default 0.95
    mockEvaluate.mockResolvedValueOnce({
      answers: { reversible: boolAnswer(0.9), inScope: boolAnswer(0.9), risk: scoreAnswer(0) },
      usage: usage(),
    } as any);

    const gate = createPermissionGate();
    const result = await gate.check({ tool: { name: 'postMessage' }, task: 'x' });

    expect(result.decision).toBe('ask-human');
  });

  it('auto-approves only when reversibility, scope and low risk are all near-certain', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { reversible: boolAnswer(0.99), inScope: boolAnswer(0.99), risk: scoreAnswer(0) },
      usage: usage(),
    } as any);

    const gate = createPermissionGate();
    const result = await gate.check({ tool: { name: 'listFiles' }, task: 'x' });

    expect(result.decision).toBe('auto-approve');
  });

  it('blocks at a moderate risk score well before it would ever reach the auto-approve bar', async () => {
    // risk score 3 of 5 levels (0..4) => risk = 3/4 = 0.75 >= default block threshold 0.6
    mockEvaluate.mockResolvedValueOnce({
      answers: { reversible: boolAnswer(0.5), inScope: boolAnswer(0.9), risk: scoreAnswer(3) },
      usage: usage(),
    } as any);

    const gate = createPermissionGate();
    const result = await gate.check({ tool: { name: 'wireTransfer' }, task: 'x' });

    expect(result.decision).toBe('block');
    expect(result.risk).toBeCloseTo(0.75, 5);
  });

  it('the block threshold is a lower bar than the auto-approve bar (asymmetry is directional)', () => {
    const gate = createPermissionGate();
    expect(gate.policy.thresholds.block).toBeLessThan(gate.policy.thresholds.autoApprove);
  });

  it('honors custom thresholds', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { reversible: boolAnswer(0.8), inScope: boolAnswer(0.8), risk: scoreAnswer(0) },
      usage: usage(),
    } as any);

    // safety = min(1, 0.8, 0.8) = 0.8, which clears a relaxed 0.5 bar
    const gate = createPermissionGate({ policy: { thresholds: { autoApprove: 0.5, block: 0.9 } } });
    const result = await gate.check({ tool: { name: 'listFiles' }, task: 'x' });

    expect(result.decision).toBe('auto-approve');
  });
});

describe('createPermissionGate — fractional scores', () => {
  it('normalizes a fractional score against (levels - 1)', async () => {
    // 5 risk levels declared (indices 0..4); a fractional score of 2.5 => risk 2.5/4 = 0.625
    mockEvaluate.mockResolvedValueOnce({
      answers: { reversible: boolAnswer(0.5), inScope: boolAnswer(0.5), risk: scoreAnswer(2.5) },
      usage: usage(),
    } as any);

    const gate = createPermissionGate();
    const result = await gate.check({ tool: { name: 'updateRecord' }, task: 'x' });

    expect(result.risk).toBeCloseTo(0.625, 5);
  });
});

describe('createPermissionGate — missing probabilities', () => {
  it('does not crash when the score/choice answers omit the optional `probabilities` map', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: {
        reversible: boolAnswer(0.9),
        inScope: boolAnswer(0.9),
        risk: { type: 'score', score: 1 }, // no `probabilities` field at all
      },
      usage: usage(),
    } as any);

    const gate = createPermissionGate();
    const result = await gate.check({ tool: { name: 'listFiles' }, task: 'x' });

    expect(result.risk).toBeCloseTo(0.25, 5);
    expect(result.reason).toBe('threshold');
  });
});

describe('createPermissionGate — fail-closed', () => {
  it('defaults to ask-human when the Jev call throws', async () => {
    mockEvaluate.mockRejectedValueOnce(new Error('network error'));

    const gate = createPermissionGate();
    const result = await gate.check({ tool: { name: 'deleteEverything' }, task: 'x' });

    expect(result.decision).toBe('ask-human');
    expect(result.reason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
  });

  it('never silently auto-approves on error, even with a custom onError', async () => {
    mockEvaluate.mockRejectedValueOnce(new Error('timeout'));

    const gate = createPermissionGate({ policy: { onError: 'block' } });
    const result = await gate.check({ tool: { name: 'deleteEverything' }, task: 'x' });

    expect(result.decision).toBe('block');
    expect(result.decision).not.toBe('auto-approve');
  });

  it('fails closed with a clear error when neither auth env var is configured', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;

    const gate = createPermissionGate();
    const result = await gate.check({ tool: { name: 'listFiles' }, task: 'x' });

    expect(result.decision).toBe('ask-human');
    expect(result.reason).toBe('error');
    expect(String((result.error as Error)?.message)).toMatch(/AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN/);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});
