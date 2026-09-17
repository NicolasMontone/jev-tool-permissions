import { describe, it, expect } from 'vitest';
import { matchesRule, matchesAny, evaluateDeterministic } from '../src/rules.js';

describe('matchesRule', () => {
  it('matches a glob with *', () => {
    expect(matchesRule('read*', 'readFile')).toBe(true);
    expect(matchesRule('read*', 'writeFile')).toBe(false);
  });

  it('matches a glob with * in the middle and end', () => {
    expect(matchesRule('*.delete*', 'db.deleteRecord')).toBe(true);
    expect(matchesRule('*.delete*', 'db.updateRecord')).toBe(false);
  });

  it('matches a glob with ?', () => {
    expect(matchesRule('tool?', 'toolA')).toBe(true);
    expect(matchesRule('tool?', 'toolAB')).toBe(false);
  });

  it('escapes regex-special characters in the literal portion of a glob', () => {
    expect(matchesRule('a.b', 'a.b')).toBe(true);
    expect(matchesRule('a.b', 'axb')).toBe(false); // '.' is literal, not "any char"
  });

  it('matches a RegExp', () => {
    expect(matchesRule(/^delete/i, 'DeleteRecord')).toBe(true);
    expect(matchesRule(/^delete/i, 'readRecord')).toBe(false);
  });

  it('matches a predicate function, passing through the input', () => {
    const rule = (name: string, input?: unknown) => name === 'writeFile' && (input as any)?.path?.startsWith('/etc');
    expect(matchesRule(rule, 'writeFile', { path: '/etc/passwd' })).toBe(true);
    expect(matchesRule(rule, 'writeFile', { path: '/tmp/x' })).toBe(false);
  });
});

describe('matchesAny', () => {
  it('is false for an empty or undefined rule list', () => {
    expect(matchesAny(undefined, 'anything')).toBe(false);
    expect(matchesAny([], 'anything')).toBe(false);
  });

  it('is true if any rule matches', () => {
    expect(matchesAny(['list*', 'get*'], 'getUser')).toBe(true);
    expect(matchesAny(['list*', 'get*'], 'deleteUser')).toBe(false);
  });
});

describe('evaluateDeterministic', () => {
  it('returns null when neither deny nor allow match (defers to the probabilistic layer)', () => {
    expect(evaluateDeterministic('mysteryTool', undefined, ['deny*'], ['allow*'])).toBeNull();
  });

  it('returns "allow" when only an allow rule matches', () => {
    expect(evaluateDeterministic('readFile', undefined, ['*.delete*'], ['read*'])).toBe('allow');
  });

  it('returns "deny" when only a deny rule matches', () => {
    expect(evaluateDeterministic('deleteFile', undefined, ['*delete*'], ['read*'])).toBe('deny');
  });

  it('deny always wins over allow for the same tool (the deterministic floor is a safety net)', () => {
    expect(evaluateDeterministic('deleteFile', undefined, ['*delete*'], ['*delete*'])).toBe('deny');
  });
});
