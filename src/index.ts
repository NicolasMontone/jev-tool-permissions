export {
  createPermissionGate,
  type PermissionGate,
} from './gate.js';

export { pruneTools } from './prune.js';

export { matchesRule, matchesAny, evaluateDeterministic } from './rules.js';

export { JevAuthError, assertGatewayAuthConfigured } from './errors.js';

export {
  createToolApproval,
  createPruningPrepareStep,
  filterToolsForTask,
  extractTaskFromMessages,
  type CreateToolApprovalOptions,
  type CreatePruningPrepareStepOptions,
  type FilterToolsForTaskOptions,
  type FilterToolsForTaskResult,
} from './integration.js';

export type {
  RuleSpec,
  JevUsage,
  OnErrorBehavior,
  ThresholdConfig,
  ToolDescriptor,
  HistoryEntry,
  Decision,
  DecisionReason,
  CheckInput,
  CheckResult,
  PermissionPolicy,
  PrunableTool,
  ToolsInput,
  PruneThresholds,
  PrunePolicy,
  PruneInput,
  PruneResult,
} from './types.js';

export {
  DEFAULT_THRESHOLDS,
  DEFAULT_MODEL,
  DEFAULT_ON_ERROR,
  DEFAULT_PRUNE_THRESHOLDS,
} from './types.js';
