import type { RuleSpec } from './types.js';

/**
 * Converts a glob pattern (`*` = any run of characters, `?` = any single
 * character) into a fully-anchored RegExp. Everything else is escaped
 * literally, so `.`, `(`, etc. in a tool name are matched as themselves.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (const ch of glob) {
    if (ch === '*') {
      pattern += '.*';
    } else if (ch === '?') {
      pattern += '.';
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** Whether a single rule matches a given tool call. */
export function matchesRule(rule: RuleSpec, toolName: string, input?: unknown): boolean {
  if (typeof rule === 'string') {
    return globToRegExp(rule).test(toolName);
  }
  if (rule instanceof RegExp) {
    return rule.test(toolName);
  }
  return rule(toolName, input);
}

/** Whether any rule in the list matches. */
export function matchesAny(rules: RuleSpec[] | undefined, toolName: string, input?: unknown): boolean {
  if (!rules || rules.length === 0) return false;
  return rules.some((rule) => matchesRule(rule, toolName, input));
}

export type DeterministicVerdict = 'deny' | 'allow' | null;

/**
 * Evaluates the deterministic floor: deny rules are checked before allow
 * rules, so an explicit deny always wins over an explicit allow for the same
 * tool. Returns `null` when no rule matches, meaning the probabilistic layer
 * (Jev) decides.
 */
export function evaluateDeterministic(
  toolName: string,
  input: unknown,
  deny: RuleSpec[] | undefined,
  allow: RuleSpec[] | undefined,
): DeterministicVerdict {
  if (matchesAny(deny, toolName, input)) return 'deny';
  if (matchesAny(allow, toolName, input)) return 'allow';
  return null;
}
