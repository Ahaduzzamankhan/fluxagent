/**
 * FluxAgent — runtime.
 *
 * Composes the whole system from config: controllers, tool registry,
 * permission manager, LLM provider, memory, and the Agent. This is the single
 * entry point the CLI / desktop UI will construct.
 */

import * as path from "node:path";

import { Logger } from "../utils/logger.ts";
import { EventBus, EventRecorder } from "../events/event-bus.ts";
import { FileController } from "../controllers/files.ts";
import { CommandController } from "../controllers/command.ts";
import { ProcessController } from "../controllers/process.ts";
import { ScreenController } from "../controllers/screen.ts";
import { KeyboardController } from "../controllers/keyboard.ts";
import { MouseController } from "../controllers/mouse.ts";
import { WindowController } from "../controllers/window.ts";
import { ApplicationController } from "../controllers/application.ts";
import { SystemController } from "../controllers/system.ts";
import { NetworkController } from "../controllers/network.ts";

import { ToolRegistry } from "../tools/registry.ts";
import { createFileTools } from "../tools/builtin/file-tools.ts";
import { createCommandTools, createProcessTools } from "../tools/builtin/command-tools.ts";
import { createScreenTools, createInputTools, createSystemTools } from "../tools/builtin/screen-tools.ts";

import { PermissionManager } from "../security/permission-manager.ts";
import { AutoApproveRequester, AutoDenyApprovalRequester, type ApprovalRequester } from "../security/approval.ts";
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from "../security/sandbox.ts";
import { isPermissionLevel } from "../tools/permissions.ts";

import type { LlmProvider } from "../llm/provider.ts";
import { StateManager } from "../agent/state.ts";
import { RunContext } from "../agent/context.ts";
import { ReasoningEngine } from "../agent/reasoning.ts";
import { Planner } from "../agent/planner.ts";
import { Executor } from "../agent/executor.ts";
import { Observer, fileVerifier } from "../agent/observer.ts";
import { RecoveryManager } from "../agent/recovery.ts";
import { Agent } from "../agent/agent.ts";
import { PythonBridge } from "../python/bridge.ts";
import { createPythonExecuteTool } from "../python/python-tools.ts";
import { JsonFileLongTermMemory, InMemoryLongTermMemory } from "../memory/long-term.ts";
import { Session } from "./session.ts";
import type { RuntimeConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";

// Phase 3–5 brain expansion
import { ToolDiscovery } from "../tools/discovery.ts";
import { ModelRouterService, mockModelDescriptor } from "../llm/router.ts";
import { ObservationEngine } from "../agent/observation-engine.ts";
import { RecoveryEngine } from "../agent/recovery-engine.ts";
import { HeuristicDecisionEngine } from "../agent/decision.ts";
import { SelfEvaluator, ExecutionLearner } from "../agent/evaluation.ts";
import { ContextManager } from "../agent/context-manager.ts";
import { LayeredMemory } from "../memory/layers.ts";
import { TaskManager } from "../planning/task-manager.ts";
import { TraceRecorder } from "./trace.ts";
import { CheckpointManager, InMemoryCheckpointStore, type CheckpointStore } from "./checkpoint.ts";
import { attachEventBus } from "./trace.ts";
import { SubagentManager } from "../agent/subagent.ts";
// Phase 4/6 integrations
import { SemanticMemoryService, InMemorySemanticStore } from "../memory/semantic.ts";
import { SkillRegistry, builtinSkills } from "../skills/skill.ts";

export interface RuntimeOptions {
  readonly config?: RuntimeConfig;
  readonly provider: LlmProvider;
  readonly approvalRequester?: ApprovalRequester;
  readonly logger?: Logger;
  readonly cwd?: string;
}

/** The composed session graph (session + agent pieces) returned by the runtime. */
export interface FluxSession extends Session {
  readonly agent: Agent;
  readonly state: StateManager;
  readonly permissions: PermissionManager;
  readonly executor: Executor;
  readonly planner: Planner;
  readonly reasoning: ReasoningEngine;
  readonly context: RunContext;
  readonly observer: Observer;
  readonly recovery: RecoveryManager;
  // Phase 3–5 brain expansion
  readonly discovery: ToolDiscovery;
  readonly decisionEngine: HeuristicDecisionEngine;
  readonly observationEngine: ObservationEngine;
  readonly recoveryEngine: RecoveryEngine;
  readonly selfEvaluator: SelfEvaluator;
  readonly learner: ExecutionLearner;
  readonly contextManager: ContextManager;
  readonly layeredMemory: LayeredMemory;
  readonly taskManager: TaskManager;
  readonly trace: TraceRecorder;
  readonly checkpoints: CheckpointManager;
  readonly subagents: SubagentManager | null;
}

export interface FluxRuntime {
  readonly config: RuntimeConfig;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly recorder: EventRecorder;
  readonly registry: ToolRegistry;
  readonly python: PythonBridge | null;
  readonly discovery: ToolDiscovery;
  readonly modelRouter: ModelRouterService;
  readonly trace: TraceRecorder;
  readonly checkpointStore: CheckpointStore;
  createSession(options?: { goal?: string }): FluxSession;
  // ── Phase 10–11 integration surface (key-free; safe for the API) ──────────
  /** Registered model providers: identity + capability info, never secrets. */
  listProviders(): readonly { id: string; kind: string; baseUrl?: string; hasApiKey: boolean; models: readonly string[] }[];
  /** Skills with readiness against the current registry. */
  listSkills(): readonly { name: string; description: string; version: string; requiredTools: readonly string[]; ready: boolean; missingTools: readonly string[] }[];
  /** Semantic memory stats (counts by kind). */
  semanticMemoryStats(): Promise<{ total: number; byKind: Record<string, number>; forgotten: number }>;
  /** Semantic memory search for the API/memory tooling. */
  semanticMemorySearch(query: string, limit?: number): Promise<readonly { id: string; kind: string; content: string; importance: number; provenance: { source: string; type: string } }[]>;
}

export function createRuntime(options: RuntimeOptions): FluxRuntime {
  const config = options.config ?? DEFAULT_CONFIG;
  const cwd = options.cwd ?? process.cwd();
  const logger =
    options.logger ??
    new Logger({ component: "runtime", level: config.logging.level, redactKeys: config.logging.redactKeys });
  const bus = new EventBus({ logger });
  const recorder = new EventRecorder();
  recorder.attach(bus);

  // ── sandbox policy from config ───────────────────────────────────────────────
  const policy: SandboxPolicy = {
    ...DEFAULT_SANDBOX_POLICY,
    allowedRoots: config.security.allowedRoots,
    deniedRoots: config.security.deniedRoots,
    blockedCommandTokens: config.security.blockedCommandTokens,
  };

  // ── controllers ──────────────────────────────────────────────────────────────
  const files = new FileController({ sandboxPolicy: policy });
  const command = new CommandController({ sandboxPolicy: policy });
  const processes = new ProcessController(command);
  const windows = new WindowController(command);
  const screen = new ScreenController();
  const keyboard = new KeyboardController();
  const mouse = new MouseController();
  const apps = new ApplicationController(command, processes, windows);
  const system = new SystemController(command);
  const network = new NetworkController();
  void network; // reserved for network tools/plugins

  // ── tools ────────────────────────────────────────────────────────────────────
  const registry = new ToolRegistry({ sessionId: "runtime", logger });
  registry.registerAll(createFileTools(files));
  registry.registerAll(createCommandTools(command));
  registry.registerAll(createProcessTools(processes));
  registry.registerAll(createScreenTools(screen));
  registry.registerAll(createInputTools(keyboard, mouse));
  registry.registerAll(createSystemTools(system, apps));

  // ── python bridge (optional) ─────────────────────────────────────────────────
  let python: PythonBridge | null = null;
  if (config.python.enabled) {
    python = new PythonBridge({
      interpreter: config.python.interpreter,
      workerScript: path.join(cwd, config.python.workerScript),
      cwd,
      timeoutMs: config.python.timeoutMs,
      logger: logger.child("python"),
    });
    registry.register(createPythonExecuteTool(python));
  }

  // ── Phase 3–5 runtime-level services ─────────────────────────────────────────
  const discovery = new ToolDiscovery(registry);
  const modelRouter = new ModelRouterService();
  modelRouter.registerModel(mockModelDescriptor());
  const trace = new TraceRecorder();
  const checkpointStore: CheckpointStore = new InMemoryCheckpointStore();
  const approvalRequester =
    config.security.mode === "auto-approve"
      ? new AutoApproveRequester()
      : options.approvalRequester ?? new AutoDenyApprovalRequester();

  // ── Phase 4/6/1 wiring: semantic memory, skills, provider registry ─────────
  const semanticMemory = new SemanticMemoryService({ store: new InMemorySemanticStore() });
  const skillRegistry = new SkillRegistry();
  skillRegistry.registerAll(builtinSkills());

  const runtime: FluxRuntime = {
    config,
    logger,
    bus,
    recorder,
    registry,
    python,
    discovery,
    modelRouter,
    trace,
    checkpointStore,
    createSession(sessionOptions: { goal?: string } = {}): FluxSession {
      const session = new Session({
        goal: sessionOptions.goal,
        logger: logger.child("session"),
        longTermMemory: buildLongTermMemory(config, cwd),
      });
      const state = new StateManager(session.id, sessionOptions.goal ?? "");

      const permissions = new PermissionManager({
        sessionId: session.id,
        ceiling: isPermissionLevel(config.security.ceiling) ? config.security.ceiling : "USER_CONFIRMATION",
        approvalRequester,
        autoApproveBelow: config.security.mode === "deny-all" ? "READ_ONLY" : "SAFE_WRITE",
        approvalTimeoutMs: config.security.approvalTimeoutMs,
        logger: logger.child("permissions"),
        eventBus: session.bus,
      });

      const context = new RunContext({ state, conversation: session.conversation, registry });

      const observer = new Observer({
        sessionId: session.id,
        state,
        memory: session.shortTerm,
        eventBus: session.bus,
        logger: logger.child("observer"),
        verifiers: { "file.": fileVerifier },
      });

      const recovery = new RecoveryManager({ eventBus: session.bus, logger: logger.child("recovery") });

      // ── Phase 3–5 brain subsystems ────────────────────────────────────────
      const discovery = new ToolDiscovery(registry);
      // Screen/input tools need backends that are not wired yet — mark unavailable.
      for (const name of ["screen.screenshot", "screen.dimensions", "screen.monitors", "keyboard.type", "keyboard.press", "keyboard.hotkey", "mouse.move", "mouse.click", "mouse.doubleClick", "mouse.scroll"]) {
        if (registry.has(name)) discovery.setAvailability(name, false, "no OS backend wired yet (Python bridge / native addon pending)");
      }
      const decisionEngine = new HeuristicDecisionEngine(registry);
      const observationEngine = new ObservationEngine({ logger: logger.child("observation-engine") });
      const recoveryEngine = new RecoveryEngine({ eventBus: session.bus, logger: logger.child("recovery-engine") });
      const selfEvaluator = new SelfEvaluator();
      const learner = new ExecutionLearner();
      const contextManager = new ContextManager();
      const layeredMemory = new LayeredMemory({ sessionId: session.id });
      const taskManager = new TaskManager();
      // Bridge session events into the runtime-level trace so diagnostics
      // are automatic — one recorder serves every session in this runtime.
      attachEventBus(trace, session.bus);
      const checkpoints = new CheckpointManager({ store: checkpointStore, eventBus: session.bus });
      const subagents: SubagentManager | null = null; // wired per-session below

      const executor = new Executor({
        sessionId: session.id,
        registry,
        permissions,
        observer,
        recovery,
        state,
        eventBus: session.bus,
        logger: logger.child("executor"),
        stepTimeoutMs: config.runtime.stepTimeoutMs,
      });

      const planner = new Planner({
        registry,
        maxPlanSteps: config.planning.maxPlanSteps,
        logger: logger.child("planner"),
      });
      const reasoning = new ReasoningEngine({
        provider: options.provider,
        context,
        logger: logger.child("reasoning"),
      });

      const agent = new Agent({
        sessionId: session.id,
        provider: options.provider,
        registry,
        permissions,
        state,
        context,
        reasoning,
        planner,
        executor,
        observer,
        recovery,
        eventBus: session.bus,
        memory: session.memory,
        logger: logger.child("agent"),
        maxSteps: config.runtime.maxSteps,
        maxReplans: config.planning.allowReplanning ? 2 : 0,
      });

      const sessionSubagents = new SubagentManager({
        parentCeiling: isPermissionLevel(config.security.ceiling) ? config.security.ceiling : "USER_CONFIRMATION",
        eventBus: session.bus,
        logger: logger.child("subagents"),
        createAgent: ({ toolNames, ceiling }) => {
          // Scoped registry: only the allowed tools are visible to the child.
          const childRegistry = new ToolRegistry({ sessionId: session.id, logger });
          for (const name of toolNames) {
            const t = registry.get(name);
            if (t) childRegistry.register(t);
          }
          const childPermissions = new PermissionManager({
            sessionId: session.id,
            ceiling,
            approvalRequester,
            autoApproveBelow: "SAFE_WRITE",
            logger: logger.child("subagent-permissions"),
            eventBus: session.bus,
          });
          const childState = new StateManager(session.id, "");
          const childContext = new RunContext({ state: childState, conversation: session.conversation, registry: childRegistry });
          const childObserver = new Observer({ sessionId: session.id, state: childState, memory: session.shortTerm, eventBus: session.bus, logger });
          const childRecovery = new RecoveryManager({ eventBus: session.bus, logger });
          const childExecutor = new Executor({
            sessionId: session.id,
            registry: childRegistry,
            permissions: childPermissions,
            observer: childObserver,
            recovery: childRecovery,
            state: childState,
            eventBus: session.bus,
            logger,
          });
          const childPlanner = new Planner({ registry: childRegistry, maxPlanSteps: config.planning.maxPlanSteps, logger });
          const childReasoning = new ReasoningEngine({ provider: options.provider, context: childContext, logger });
          return new Agent({
            sessionId: session.id,
            provider: options.provider,
            registry: childRegistry,
            permissions: childPermissions,
            state: childState,
            context: childContext,
            reasoning: childReasoning,
            planner: childPlanner,
            executor: childExecutor,
            observer: childObserver,
            recovery: childRecovery,
            eventBus: session.bus,
            memory: session.memory,
            logger,
          });
        },
      });

      return Object.assign(session, {
        agent,
        state,
        permissions,
        executor,
        planner,
        reasoning,
        context,
        observer,
        recovery,
        discovery,
        decisionEngine,
        observationEngine,
        recoveryEngine,
        selfEvaluator,
        learner,
        contextManager,
        layeredMemory,
        taskManager,
        trace,
        checkpoints,
        subagents: sessionSubagents,
      });
    },

    listProviders() {
      return runtime.modelRouter.listModels().map((m) => {
        const desc = m as unknown as { id: string; provider?: string; baseUrl?: string; hasApiKey?: boolean; model?: string };
        return {
          id: desc.id,
          kind: desc.provider ?? desc.id.split(":")[0] ?? "unknown",
          ...(desc.baseUrl ? { baseUrl: desc.baseUrl } : {}),
          hasApiKey: desc.hasApiKey ?? false,
          models: [desc.model ?? desc.id],
        };
      });
    },

    listSkills() {
      skillRegistry.setAvailableTools(registry.names());
      return skillRegistry.list().map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        requiredTools: s.requiredTools,
        ready: skillRegistry.isReady(s),
        missingTools: skillRegistry.missingTools(s),
      }));
    },

    async semanticMemoryStats() {
      return semanticMemory.stats();
    },

    async semanticMemorySearch(query: string, limit = 10) {
      const hits = await semanticMemory.retrieve({ query, limit });
      return hits.map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        importance: r.importance,
        provenance: { source: r.provenance.source, type: r.provenance.type },
      }));
    },
  };

  return runtime;
}

function buildLongTermMemory(config: RuntimeConfig, cwd: string) {
  if (config.memory.longTermDirectory === ":memory:") {
    return new InMemoryLongTermMemory();
  }
  return new JsonFileLongTermMemory({ directory: path.join(cwd, config.memory.longTermDirectory) });
}
