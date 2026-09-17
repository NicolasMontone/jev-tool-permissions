import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, experimental_evaluate: vi.fn() };
});

import { experimental_evaluate } from 'ai';
import { pruneTools } from '../src/prune.js';

const mockEvaluate = vi.mocked(experimental_evaluate);

function boolAnswer(probability: number) {
  return { type: 'boolean' as const, probability };
}

function usage() {
  return { inputTokens: 500, outputTokens: 30, totalTokens: 530 };
}

beforeEach(() => {
  mockEvaluate.mockReset();
  process.env.AI_GATEWAY_API_KEY = 'test-key';
  delete process.env.VERCEL_OIDC_TOKEN;
});

const bigToolSet = {
  readFile: { description: 'Read a file from disk' },
  writeFile: { description: 'Write a file to disk' },
  listDirectory: { description: 'List a directory' },
  sendEmail: { description: 'Send an email' },
  queryDatabase: { description: 'Run a read-only SQL query' },
};

describe('pruneTools — one round trip', () => {
  it('makes exactly ONE evaluate() call for N tools, with one question per tool', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: Object.fromEntries(Object.keys(bigToolSet).map((name) => [name, boolAnswer(0.5)])),
      usage: usage(),
    } as any);

    await pruneTools({ tools: bigToolSet, task: 'read some files' });

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    const call = mockEvaluate.mock.calls[0]![0] as any;
    expect(Object.keys(call.questions).sort()).toEqual(Object.keys(bigToolSet).sort());
    for (const q of Object.values(call.questions) as any[]) {
      expect(q.type).toBe('boolean');
    }
  });

  it('shares one task/history state across all per-tool questions', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: Object.fromEntries(Object.keys(bigToolSet).map((name) => [name, boolAnswer(0.9)])),
      usage: usage(),
    } as any);

    await pruneTools({ tools: bigToolSet, task: 'read some files', history: [{ step: 1 }] });

    const call = mockEvaluate.mock.calls[0]![0] as any;
    expect(call.state.task).toBe('read some files');
    expect(call.state.history).toEqual([{ step: 1 }]);
  });
});

describe('pruneTools — deterministic floor', () => {
  it('drops deny-matched tools and keeps allow-matched tools without asking Jev about them', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { queryDatabase: boolAnswer(0.1) }, // only the undecided tool is asked about
      usage: usage(),
    } as any);

    const result = await pruneTools({
      tools: bigToolSet,
      task: 'read some files',
      policy: { deny: ['sendEmail'], allow: ['readFile', 'writeFile', 'listDirectory'] },
    });

    const call = mockEvaluate.mock.calls[0]![0] as any;
    expect(Object.keys(call.questions)).toEqual(['queryDatabase']);

    expect(result.dropped).toContain('sendEmail');
    expect(result.tools).toHaveProperty('readFile');
    expect(result.tools).toHaveProperty('writeFile');
    expect(result.tools).toHaveProperty('listDirectory');
    expect(result.tools).not.toHaveProperty('sendEmail');
  });

  it('makes no evaluate() call at all when every tool is rule-decided', async () => {
    const result = await pruneTools({
      tools: { readFile: bigToolSet.readFile, sendEmail: bigToolSet.sendEmail },
      task: 'x',
      policy: { deny: ['sendEmail'], allow: ['readFile'] },
    });

    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(result.tools).toEqual({ readFile: bigToolSet.readFile });
    expect(result.dropped).toEqual(['sendEmail']);
  });
});

describe('pruneTools — relevance threshold', () => {
  it('keeps tools at/above the keep threshold and drops tools below it', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: {
        readFile: boolAnswer(0.9),
        writeFile: boolAnswer(0.2), // exactly at default threshold (0.2) -> kept
        listDirectory: boolAnswer(0.19), // just below -> dropped
        sendEmail: boolAnswer(0.01),
        queryDatabase: boolAnswer(0.5),
      },
      usage: usage(),
    } as any);

    const result = await pruneTools({ tools: bigToolSet, task: 'read some files' });

    expect(result.tools).toHaveProperty('readFile');
    expect(result.tools).toHaveProperty('writeFile');
    expect(result.tools).toHaveProperty('queryDatabase');
    expect(result.tools).not.toHaveProperty('listDirectory');
    expect(result.tools).not.toHaveProperty('sendEmail');
    expect(result.dropped.sort()).toEqual(['listDirectory', 'sendEmail'].sort());
    expect(result.relevance.readFile).toBeCloseTo(0.9);
  });

  it('reports an estimated token savings for dropped tools', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: Object.fromEntries(Object.keys(bigToolSet).map((name) => [name, boolAnswer(0.01)])),
      usage: usage(),
    } as any);

    const result = await pruneTools({ tools: bigToolSet, task: 'x' });

    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.savedTokens).toBeGreaterThan(0);
  });
});

describe('pruneTools — fail open on error', () => {
  it('keeps all pending tools (does not drop anything) when the Jev call throws', async () => {
    mockEvaluate.mockRejectedValueOnce(new Error('network error'));

    const result = await pruneTools({ tools: bigToolSet, task: 'x' });

    expect(Object.keys(result.tools).sort()).toEqual(Object.keys(bigToolSet).sort());
    expect(result.dropped).toEqual([]);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('still drops deny-matched tools even when the Jev call fails (rules stay authoritative)', async () => {
    mockEvaluate.mockRejectedValueOnce(new Error('network error'));

    const result = await pruneTools({
      tools: bigToolSet,
      task: 'x',
      policy: { deny: ['sendEmail'] },
    });

    expect(result.tools).not.toHaveProperty('sendEmail');
    expect(result.dropped).toEqual(['sendEmail']);
  });

  it('fails open (keeps everything) when auth is not configured, rather than breaking the turn', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;

    const result = await pruneTools({ tools: bigToolSet, task: 'x' });

    expect(Object.keys(result.tools).sort()).toEqual(Object.keys(bigToolSet).sort());
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(result.error).toBeDefined();
  });
});
