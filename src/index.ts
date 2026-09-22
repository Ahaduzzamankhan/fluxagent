/**
 * FluxAgent — public API.
 *
 * The desktop UI / CLI should import from here only. Construction flows:
 *
 *   import { createRuntime, MockLlmProvider } from "fluxagent";
 *   const runtime = createRuntime({ provider: new MockLlmProvider({...}) });
 *   const session = runtime.createSession({ goal: "..." });
 *   const result = await session.agent.run("goal text");
 */

// runtime
export { createRuntime } from "./runtime/runtime.ts";
export type { FluxRuntime, FluxSession, RuntimeOptions } from "./runtime/runtime.ts";
export { Session } from "./runtime/session.ts";
export { loadConfig, DEFAULT_CONFIG } from "./runtime/config.ts";
export type { RuntimeConfig } from "./runtime/config.ts";

// agent brain
export { Agent } from "./agent/agent.ts";
export type { AgentRunResult } from "./agent/agent.ts";
export { StateManager, createAgentState, serializeState, deserializeState, makeObservation } from "./agent/state.ts";
export type { AgentState, Observation } from "./agent/state.ts";
export { RunContext } from "./agent/context.ts";
export { ReasoningEngine } from "./agent/reasoning.ts";
export { Planner } from "./agent/planner.ts";
export { Executor } from "./agent/executor.ts";
export { Observer, fileVerifier } from "./agent/observer.ts";
export { RecoveryManager, DEFAULT_RECOVERY_POLICY } from "./agent/recovery.ts";
export type { FailureClass, RecoveryDecision, RecoveryPolicy } from "./agent/recovery.ts";

// planning
export {
  createPlan,
  createStep,
  createTask,
  topoSort,
  dependenciesSatisfied,
  anyDependencyFailed,
} from "./planning/plan.ts";
export type { Plan, PlanStep, Task, StepStatus, StepResultData } from "./planning/plan.ts";
export { analyzeDependencies, dependencyEdges } from "./planning/dependency.ts";
export type { DependencyReport } from "./planning/dependency.ts";
export { transitionTask, isPlanComplete, countByStatus } from "./planning/task.ts";

// tools
export { ToolRegistry } from "./tools/registry.ts";
export { defineTool, toolInfo } from "./tools/tool.ts";
export type { Tool, ToolInfo, ToolContext, ToolExecutionResult, ToolErrorPayload } from "./tools/tool.ts";
export { PERMISSION_LEVELS, permissionRank, permissionAtLeast, isPermissionLevel } from "./tools/permissions.ts";
export type { PermissionLevel } from "./tools/permissions.ts";
export { S, validateAgainstSchema } from "./tools/schemas.ts";
export type { JSONSchema, ValidationResult } from "./tools/schemas.ts";
export { createFileTools } from "./tools/builtin/file-tools.ts";
export { createCommandTools, createProcessTools } from "./tools/builtin/command-tools.ts";
export { createScreenTools, createInputTools, createSystemTools } from "./tools/builtin/screen-tools.ts";

// controllers
export { FileController } from "./controllers/files.ts";
export type { FileMetadata, DirectoryEntry } from "./controllers/files.ts";
export { CommandController } from "./controllers/command.ts";
export type { CommandSpec, CommandResult } from "./controllers/command.ts";
export { ProcessController, parseTasklist } from "./controllers/process.ts";
export { ScreenController, UnavailableScreenBackend } from "./controllers/screen.ts";
export type { ScreenCaptureBackend, Screenshot, MonitorInfo } from "./controllers/screen.ts";
export { KeyboardController, UnavailableInputBackend } from "./controllers/keyboard.ts";
export type { InputInjectionBackend, KeyEvent } from "./controllers/keyboard.ts";
export { MouseController, UnavailableMouseBackend } from "./controllers/mouse.ts";
export type { MouseBackend, Point, ClickOptions, ScrollOptions } from "./controllers/mouse.ts";
export { WindowController, parseWindowLines } from "./controllers/window.ts";
export { ApplicationController } from "./controllers/application.ts";
export { SystemController } from "./controllers/system.ts";
export { NetworkController } from "./controllers/network.ts";

// security
export { PermissionManager } from "./security/permission-manager.ts";
export {
  AutoApproveRequester,
  AutoDenyApprovalRequester,
  ConsoleApprovalRequester,
  requestWithTimeout,
} from "./security/approval.ts";
export type { ApprovalRequester, ApprovalRequest, ApprovalDecision } from "./security/approval.ts";
export {
  DEFAULT_SANDBOX_POLICY,
  checkPathAllowed,
  checkCommandAllowed,
  isInsideRoot,
  canonicalPath,
} from "./security/sandbox.ts";
export type { SandboxPolicy } from "./security/sandbox.ts";

// memory
export { MemoryManager } from "./memory/memory.ts";
export type {
  ShortTermMemory,
  LongTermMemory,
  VectorMemory,
  EmbeddingProvider,
  MemoryRecord,
  MemoryQuery,
  ConversationTurn,
} from "./memory/memory.ts";
export { InMemoryShortTermMemory } from "./memory/short-term.ts";
export { JsonFileLongTermMemory, InMemoryLongTermMemory } from "./memory/long-term.ts";
export { ConversationMemory } from "./memory/conversation.ts";

// llm
export type { LlmProvider, PlannedPlan, AgentDecision, LlmGenerateOptions } from "./llm/provider.ts";
export { buildPlanMessages, buildDecideMessages, parsePlanJson, parseDecisionJson } from "./llm/provider.ts";
export type { LlmMessage, MessageRole, ToolCallRequest } from "./llm/message.ts";
export { userMessage, systemMessage, assistantMessage, toolResultMessage, renderMessage } from "./llm/message.ts";
export type { LlmResponse, StreamChunk, TokenUsage } from "./llm/response.ts";
export type { ModelDescriptor, ModelCapability, ModelRouter, RoutingConstraints } from "./llm/model.ts";
export { defaultModelRouter } from "./llm/model.ts";
export { MockLlmProvider } from "./llm/mock-provider.ts";
export type { MockDecision } from "./llm/mock-provider.ts";

// events
export { EventBus, EventRecorder } from "./events/event-bus.ts";
export type { EventPattern, AgentEventHandler } from "./events/event-bus.ts";
export { makeEvent } from "./events/events.ts";
export type { AgentEvent, AgentEventType } from "./events/events.ts";

// ─── Phase 3–5 brain expansion ────────────────────────────────────────────────

// diagnosis + decision
export { diagnose, categorize, isPermissionProblem } from "./agent/diagnosis.ts";
export type { ErrorCategory, Diagnosis, RecoveryRecommendation } from "./agent/diagnosis.ts";
export { HeuristicDecisionEngine } from "./agent/decision.ts";
export type { Decision, DecisionAction, DecisionInput, DecisionEngine, DecisionRisk } from "./agent/decision.ts";

// adaptive planning
export {
  planProgress,
  progressSummary,
  evaluatePlanValidity,
  invalidateDownstream,
  createAdaptiveStep,
  alternativesToFallbackSteps,
} from "./planning/adaptive.ts";
export type { PlanProgress, StepExpectation, InvalidationReason } from "./planning/adaptive.ts";

// observation + verification
export { ObservationEngine } from "./agent/observation-engine.ts";
export type { EnrichedObservation, StateChange, SideEffect, Evidence } from "./agent/observation-engine.ts";
export {
  verifyResult,
  verifyState,
  verifyGoal,
  defaultCompletionCriteria,
  resultRules,
} from "./agent/verification.ts";
export type { VerificationVerdict2, VerificationCheck, CompletionCriteria, ResultRule, StatePredicate } from "./agent/verification.ts";

// recovery engine (strategy-based)
export { RecoveryEngine, RECOVERY_STRATEGIES } from "./agent/recovery-engine.ts";
export type { RecoveryOutcome, RecoveryAttempt, RecoveryStrategy } from "./agent/recovery-engine.ts";

// evaluation + learning
export { SelfEvaluator, ExecutionLearner } from "./agent/evaluation.ts";
export type { SelfEvaluation, Claim, FailedStepAnalysis, WrongAssumption, ExecutionLesson } from "./agent/evaluation.ts";

// context manager
export { ContextManager, renderContext, compactObservations, DEFAULT_BUDGET } from "./agent/context-manager.ts";
export type { AssembledContext, ContextBudget, ContextItem, ContextSection } from "./agent/context-manager.ts";

// layered memory + provenance
export { LayeredMemory, InMemoryLayeredStore, provenance, procedureFromSteps } from "./memory/layers.ts";
export type {
  MemoryLayer,
  MemoryRecordV2,
  MemoryWriteRequest,
  MemorySearchRequest,
  LayeredMemoryStore,
  Provenance,
  MemorySource,
  MemoryEpistemicType,
} from "./memory/layers.ts";

// tool discovery
export { ToolDiscovery, categoryFor, riskForLevel, inferCapabilities } from "./tools/discovery.ts";
export type { ToolCapabilityProfile, ToolCategory, ToolRisk, DiscoveryQuery, DiscoveredTool } from "./tools/discovery.ts";

// subagents
export { SubagentManager } from "./agent/subagent.ts";
export type {
  SubagentSpec,
  SubagentResult,
  SubagentHandle,
  SubagentKind,
  SubagentLifecycle,
} from "./agent/subagent.ts";

// model router
export { ModelRouterService, mockModelDescriptor } from "./llm/router.ts";
export type { RouteRequest, TaskComplexity } from "./llm/router.ts";

// task manager
export { TaskManager, createManagedTask, transition as transitionTaskStatus, isOverdue, isTerminal } from "./planning/task-manager.ts";
export type { ManagedTask, TaskStatus, TaskPriority } from "./planning/task-manager.ts";
export { TaskTransitionError } from "./planning/task-manager.ts";

// checkpoints
export {
  CheckpointManager,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  CHECKPOINT_VERSION,
} from "./runtime/checkpoint.ts";
export type { Checkpoint, CheckpointStore } from "./runtime/checkpoint.ts";

// traceability
export { TraceRecorder, TRACE_EVENT_TYPES, attachEventBus } from "./runtime/trace.ts";
export type { TraceRecord, TraceEventType } from "./runtime/trace.ts";

// ─── Phase 6–13: intelligence, orchestration, API, security, eval, plugins ───

// phase 6 — task analysis, confidence, advanced decision, ledger
export { HeuristicTaskAnalyzer } from "./agent/task-analysis.ts";
export type { TaskAnalysis, TaskType, ReasoningLevel, TaskAnalysisOptions } from "./agent/task-analysis.ts";
export { confidence, combineConfidence, fromSuccessRate, confidenceLabel } from "./agent/confidence.ts";
export type { ConfidenceBasis, ConfidenceEstimate } from "./agent/confidence.ts";
export { AdvancedDecisionEngine, STRATEGIES, selectStrategy } from "./agent/decision-advanced.ts";
export type { AdvancedDecision, AdvancedDecisionInput, AdvancedDecisionEngineOptions, ExecutionStrategy, ExecutionStrategyName, StrategyContext } from "./agent/decision-advanced.ts";
export { ExecutionLedger, nextStrategyOnFailure } from "./agent/execution-ledger.ts";
export type { ToolOutcomeRecord, ModelOutcomeRecord, StrategyOutcomeRecord, RecoveryOutcomeRecord, LedgerSnapshot, AdaptiveStrategyState, ExecutionStrategyAttempt, ExecutionLedgerOptions } from "./agent/execution-ledger.ts";

// phase 7 — reliability + orchestration
export { withRetry, withTimeout, withFallback, CircuitBreaker, executeReliably, RetryExhaustedError, CircuitOpenError, delayForAttempt, DEFAULT_RETRY_POLICY } from "./runtime/reliability.ts";
export type { RetryPolicyOptions, RetryAttempt, RetryResult, CircuitBreakerOptions, CircuitState, FallbackOutcome, ReliableExecutionOptions, ReliableExecution } from "./runtime/reliability.ts";
export { TaskOrchestrator, PriorityQueue, priorityRank, analyzeTaskGraph } from "./runtime/task-orchestrator.ts";
export type { OrchestrationOptions, OrchestratorStatus, GraphReport, TaskRunner, QueuePriority } from "./runtime/task-orchestrator.ts";

// phase 8 — model gateway + API + auth
export { ModelGateway } from "./api/gateway.ts";
export type { GatewayCapability, GatewayDispatchOptions, GatewayDispatchResult } from "./api/gateway.ts";
export { AuthService, ApiKeyAuthenticator, LocalAuthenticator, generateApiKey, EnvSecretProvider, InMemorySecretProvider, CompositeSecretProvider, LOCAL_PRINCIPAL, hasScope } from "./api/auth.ts";
export type { AuthScope, Principal, Authenticator, AuthResult, SecretProvider } from "./api/auth.ts";
export { createApiServer, API_VERSION } from "./api/http-server.ts";
export type { ApiServer, ApiServerOptions } from "./api/http-server.ts";
export { apiSpec, toOpenApi, API_SPEC_VERSION, API_PATH_PREFIX } from "./api/spec.ts";
export type { ApiSpec } from "./api/spec.ts";

// phase 9 — SDK
export { FluxAgentClient, FluxAgentApiError } from "./sdk/client.ts";
export type { FluxAgentClientOptions, HealthReport, RunResultDTO, ToolInfoDTO, ModelInfoDTO } from "./sdk/client.ts";

// phase 10 — audit + untrusted-input validation
export { AuditLog, validateUntrustedInput, validatePluginManifest, DEFAULT_VALIDATION_LIMITS } from "./security/audit.ts";
export type { AuditEventType, AuditRecord, ValidationLimits, UntrustedValidationResult, PluginManifest } from "./security/audit.ts";

// phase 11 — evaluation + diagnostics
export { Evaluator, evalChecks, defaultBenchmarkCases, reportFrom, compareReports, buildDiagnostics } from "./eval/evaluation.ts";
export type { EvalCase, EvalCheck, EvalCaseResult, BenchmarkReport, BenchmarkCategory, RunDiagnostics } from "./eval/evaluation.ts";

// phase 12 — plugins
export { PluginManager, InMemoryPluginStorage, PLUGIN_API_VERSION } from "./plugins/plugin-manager.ts";
export type { FluxPlugin, PluginContext, PluginRecord, PluginLifecycleState, PluginStorage, PluginManagerOptions } from "./plugins/plugin-manager.ts";

// phase 13 — observability, environments
export { TtlCache, DEFAULT_CACHE_POLICY, ResourceLimiter, MetricsRegistry, HealthRegistry, newCorrelationId, InMemoryStorage, JsonFileStorage } from "./runtime/observability.ts";
export type { CachePolicy, CacheStats, ResourceLimits, ResourceUsage, AcquireTicket, MetricsSnapshot, HealthCheck, HealthCheckResult, KeyValueStorage } from "./runtime/observability.ts";
export { resolveEnvConfig, validateStartupConfig, requireValidConfig, ENV_PRESETS } from "./runtime/environments.ts";
export type { Environment, EnvConfig, ConfigValidationIssue } from "./runtime/environments.ts";

// python bridge
export { PythonBridge } from "./python/bridge.ts";
export { createPythonExecuteTool, createPythonCapabilitiesTool } from "./python/python-tools.ts";

// utils
export { Logger } from "./utils/logger.ts";
export type { LogLevel, LogRecord, LogSink } from "./utils/logger.ts";
export { FluxError, isFluxError, toFluxError, ValidationError, PermissionDeniedError } from "./utils/errors.ts";
export type { FluxErrorCode, FluxErrorJSON } from "./utils/errors.ts";
export { ids, newId } from "./utils/ids.ts";
export { sleep, truncate, deepFreeze } from "./utils/validation.ts";
