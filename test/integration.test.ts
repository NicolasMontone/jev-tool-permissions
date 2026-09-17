import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, experimental_evaluate: vi.fn() };
});

import { experimental_evaluate } from 'ai';
import {
  extractTaskFromMessages,
  createToolApproval,
  createPruningPrepareStep,
  filterToolsForTask,
} from '../src/integration.js';
import type { PermissionGate } from '../src/gate.js';
import type { CheckResult } from '../src/types.js';

const mockEvaluate = vi.mocked(experimental_evaluate);

beforeEach(() => {
  mockEvaluate.mockReset();
  process.env.AI_GATEWAY_API_KEY = 'test-key';
});

function boolAnswer(probability: number) {
  return { type: 'boolean' as const, probability };
}

describe('extractTaskFromMessages', () => {
  it('extracts plain string content from the last user message', () => {
    const task = extractTaskFromMessages([
      { role: 'user', content: 'first task' } as any,
      { role: 'assistant', content: 'ok' } as any,
      { role: 'user', content: 'second task' } as any,
    ]);
    expect(task).toBe('second task');
  });

  it('joins text parts when content is an array', () => {
    const task = extractTaskFromMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'image', image: 'ignored' },
          { type: 'text', text: 'part two' },
        ],
      } as any,
    ]);
    expect(task).toBe('part one\npart two');
  });

  it('returns an empty string when there is no user message', () => {
    expect(extractTaskFromMessages([{ role: 'assistant', content: 'hi' } as any])).toBe('');
  });
});

describe('createToolApproval', () => {
  function fakeGate(result: CheckResult): PermissionGate {
    return { policy: {} as any, check: vi.fn().mockResolvedValue(result) };
  }

  const baseCheckResult: CheckResult = {
    decision: 'auto-approve',
    reversible: 1,
    inScope: 1,
    risk: 0,
    reason: 'threshold',
    usage: undefined,
    ms: 1,
  };

  it('maps auto-approve to the AI SDK "approved" status', async () => {
    const approval = createToolApproval(fakeGate({ ...baseCheckResult, decision: 'auto-approve' }));
    const status = await approval({
      toolCall: { toolName: 'listFiles', input: {} } as any,
      tools: undefined,
      toolsContext: undefined as any,
      runtimeContext: undefined as any,
      messages: [{ role: 'user', content: 'task' } as any],
    });
    expect((status as any).type).toBe('approved');
  });

  it('maps ask-human to the AI SDK "user-approval" status', async () => {
    const approval = createToolApproval(fakeGate({ ...baseCheckResult, decision: 'ask-human', reason: 'threshold' }));
    const status = await approval({
      toolCall: { toolName: 'sendEmail', input: {} } as any,
      tools: undefined,
      toolsContext: undefined as any,
      runtimeContext: undefined as any,
      messages: [{ role: 'user', content: 'task' } as any],
    });
    expect((status as any).type).toBe('user-approval');
  });

  it('maps block to the AI SDK "denied" status and includes the reason', async () => {
    const approval = createToolApproval(fakeGate({ ...baseCheckResult, decision: 'block', reason: 'deny-rule', risk: 1 }));
    const status = await approval({
      toolCall: { toolName: 'deleteEverything', input: {} } as any,
      tools: undefined,
      toolsContext: undefined as any,
      runtimeContext: undefined as any,
      messages: [{ role: 'user', content: 'task' } as any],
    });
    expect((status as any).type).toBe('denied');
    expect((status as any).reason).toContain('deny-rule');
  });

  it('derives the task from messages via getTask and passes it to gate.check', async () => {
    const gate = fakeGate(baseCheckResult);
    const approval = createToolApproval(gate, { getTask: extractTaskFromMessages });
    await approval({
      toolCall: { toolName: 'listFiles', input: { dir: '.' } } as any,
      tools: undefined,
      toolsContext: undefined as any,
      runtimeContext: undefined as any,
      messages: [{ role: 'user', content: 'organize my files' } as any],
    });
    expect(gate.check).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'organize my files', tool: expect.objectContaining({ name: 'listFiles' }) }),
    );
  });
});

const tools = {
  readFile: { description: 'Read a file' },
  sendEmail: { description: 'Send an email' },
};

describe('createPruningPrepareStep', () => {
  it('prunes on the first step and returns activeTools', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { readFile: boolAnswer(0.9), sendEmail: boolAnswer(0.01) },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as any);

    const prepareStep = createPruningPrepareStep({ tools, task: 'read a file for me' });
    const result = await prepareStep({ messages: [], stepNumber: 0 } as any);

    expect(result).toEqual({ activeTools: ['readFile'] });
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached tool list on later steps instead of pruning again', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { readFile: boolAnswer(0.9), sendEmail: boolAnswer(0.01) },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as any);

    const prepareStep = createPruningPrepareStep({ tools, task: 'read a file for me' });
    await prepareStep({ messages: [], stepNumber: 0 } as any);
    const second = await prepareStep({ messages: [], stepNumber: 1 } as any);

    expect(second).toEqual({ activeTools: ['readFile'] });
    expect(mockEvaluate).toHaveBeenCalledTimes(1); // not called again for step 1
  });
});

describe('filterToolsForTask', () => {
  it('returns a real subset of the input tools via experimental_filterActiveTools', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: { readFile: boolAnswer(0.9), sendEmail: boolAnswer(0.01) },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as any);

    const result = await filterToolsForTask({ tools, task: 'read a file for me' });

    expect(result.tools).toEqual({ readFile: tools.readFile });
    expect(result.dropped).toEqual(['sendEmail']);
    expect(result.savedTokens).toBeGreaterThan(0);
  });
});
