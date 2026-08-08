import type * as React from "react";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type {
  AcpRuntimeCatalogEntry,
  AgentPersona,
  ManagedAgentBackend,
} from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import type { EditAgentFocusTarget } from "@/features/agents/openEditAgentEvent";
import {
  ADVANCED_FIELDS_MOTION_TRANSITION,
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
  PERSONA_LABEL_OPTIONAL_CLASS,
  type PersonaDropdownOption,
} from "./agentConfigOptions";
import type { InheritedDefault } from "./bakedEnvHelpers";
import type { EnvVarsValue } from "./EnvVarsEditor";
import { AddCustomHarnessDialog } from "./AddCustomHarnessDialog";
import { AdvancedRequiredBadge } from "./AdvancedRequiredBadge";
import { AgentAiDefaultsNotice } from "./AgentAiDefaults";
import { AgentDefaultsDialog } from "./AgentDefaultsDialog";
import { EditAgentAdvancedFields } from "./EditAgentAdvancedFields";
import { PersonaDropdownField } from "./PersonaDropdownField";
import { PersonaProviderApiKeyField } from "./PersonaProviderApiKeyField";
import { RunOnSummarySection } from "./RunOnSummarySection";
import { getProviderApiKeyLabel } from "./agentConfigOptions";

type Props = {
  backend: ManagedAgentBackend;
  isPending: boolean;
  runtimeDropdownValue: string;
  onRuntimeChange: (value: string) => void;
  runtimeDropdownOptions: PersonaDropdownOption[];
  selectedRuntime?: AcpRuntimeCatalogEntry;
  isAddHarnessOpen: boolean;
  onAddHarnessOpenChange: (open: boolean) => void;
  onHarnessSaved: (id: string) => void;
  selectedRuntimeId: string;
  inheritHarness: boolean;
  agentCommand: string;
  onAgentCommandChange: (value: string) => void;
  llmProviderFieldVisible: boolean;
  providerRequired: boolean;
  providerDropdownOptions: PersonaDropdownOption[];
  onProviderChange: (value: string) => void;
  providerSelectValue: string;
  isCustomProviderEditing: boolean;
  provider: string;
  onProviderIdChange: (value: string) => void;
  topLevelSecretEnvVar: string | null;
  apiKeyIsInherited: boolean;
  apiKeyInheritedLabel: string;
  apiKeyIsRequired: boolean;
  effectiveProvider: string;
  apiKeyValue: string;
  onEnvVarsChange: React.Dispatch<React.SetStateAction<EnvVarsValue>>;
  modelRequired: boolean;
  modelDiscoveryLoading: boolean;
  onModelChange: (value: string) => void;
  modelDropdownOptions: PersonaDropdownOption[];
  modelSelectValue: string;
  showCustomModelInput: boolean;
  model: string;
  onModelIdChange: (value: string) => void;
  modelStatusMessage: string | null;
  aiDefaultsOpen: boolean;
  onAiDefaultsOpenChange: (open: boolean) => void;
  aiDefaultsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  explicitModel: string;
  explicitProvider: string;
  inheritedModelDefault: InheritedDefault;
  inheritedProviderDefault: InheritedDefault;
  showAdvancedFields: boolean;
  onShowAdvancedFieldsChange: React.Dispatch<React.SetStateAction<boolean>>;
  advancedRequiredEnvKeys: readonly string[];
  acpCommand: string;
  agentArgs: string;
  autoRestartOnConfigChange: boolean;
  envVars: EnvVarsValue;
  effectiveEnvVars: EnvVarsValue;
  fileSatisfiedEnvKeys: readonly string[];
  initialFocus?: EditAgentFocusTarget;
  inheritedEnvVarsForAdvanced: Record<string, string>;
  linkedPersona: AgentPersona | null;
  prospectiveRuntimeId: string;
  parallelism: string;
  runtimeCatalogStatus: "loading" | "error" | "ready";
  prospectiveRuntime?: AcpRuntimeCatalogEntry;
  systemPrompt: string;
  onAcpCommandChange: (value: string) => void;
  onAgentArgsChange: (value: string) => void;
  onAutoRestartChange: (value: boolean) => void;
  onInheritHarnessChange: (value: boolean) => void;
  onParallelismChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
};

/** Local-only execution fields, kept separate from provider-backed agent editing. */
export function LocalAgentExecutionFields(props: Props) {
  const {
    backend,
    isPending,
    runtimeDropdownValue,
    onRuntimeChange,
    runtimeDropdownOptions,
    selectedRuntime,
    isAddHarnessOpen,
    onAddHarnessOpenChange,
    onHarnessSaved,
    selectedRuntimeId,
    inheritHarness,
    agentCommand,
    onAgentCommandChange,
    llmProviderFieldVisible,
    providerRequired,
    providerDropdownOptions,
    onProviderChange,
    providerSelectValue,
    isCustomProviderEditing,
    provider,
    onProviderIdChange,
    topLevelSecretEnvVar,
    apiKeyIsInherited,
    apiKeyInheritedLabel,
    apiKeyIsRequired,
    effectiveProvider,
    apiKeyValue,
    onEnvVarsChange,
    modelRequired,
    modelDiscoveryLoading,
    onModelChange,
    modelDropdownOptions,
    modelSelectValue,
    showCustomModelInput,
    model,
    onModelIdChange,
    modelStatusMessage,
    aiDefaultsOpen,
    onAiDefaultsOpenChange,
    aiDefaultsTriggerRef,
    explicitModel,
    explicitProvider,
    inheritedModelDefault,
    inheritedProviderDefault,
    showAdvancedFields,
    onShowAdvancedFieldsChange,
    advancedRequiredEnvKeys,
    acpCommand,
    agentArgs,
    autoRestartOnConfigChange,
    envVars,
    effectiveEnvVars,
    fileSatisfiedEnvKeys,
    initialFocus,
    inheritedEnvVarsForAdvanced,
    linkedPersona,
    prospectiveRuntimeId,
    parallelism,
    runtimeCatalogStatus,
    prospectiveRuntime,
    systemPrompt,
    onAcpCommandChange,
    onAgentArgsChange,
    onAutoRestartChange,
    onInheritHarnessChange,
    onParallelismChange,
    onSystemPromptChange,
  } = props;
  const shouldReduceMotion = useReducedMotion();
  const advancedFieldsTransition = shouldReduceMotion
    ? { duration: 0 }
    : ADVANCED_FIELDS_MOTION_TRANSITION;

  return (
    <>
      <RunOnSummarySection backend={backend} />
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="edit-agent-runtime"
        >
          Provider
        </label>
        <PersonaDropdownField
          disabled={isPending}
          id="edit-agent-runtime"
          onValueChange={onRuntimeChange}
          options={runtimeDropdownOptions}
          placeholder="Choose a provider"
          value={runtimeDropdownValue}
        />
        {selectedRuntime ? (
          <p className="text-xs text-muted-foreground">
            Detected at{" "}
            <span className="font-medium">
              {selectedRuntime.binaryPath ??
                selectedRuntime.command ??
                selectedRuntime.id}
            </span>
          </p>
        ) : null}
        <AddCustomHarnessDialog
          onOpenChange={onAddHarnessOpenChange}
          onSaved={onHarnessSaved}
          open={isAddHarnessOpen}
        />
      </div>
      {selectedRuntimeId === "custom" && !inheritHarness ? (
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="edit-agent-command"
          >
            Agent command
          </label>
          <div
            className={cn(
              "flex min-h-11 items-center px-3",
              PERSONA_FIELD_SHELL_CLASS,
            )}
          >
            <Input
              autoCorrect="off"
              className={cn(
                "h-8 px-0 py-0 leading-6",
                PERSONA_FIELD_CONTROL_CLASS,
              )}
              disabled={isPending}
              id="edit-agent-command"
              onChange={(event) => onAgentCommandChange(event.target.value)}
              placeholder="Full path or shell command"
              value={agentCommand}
            />
          </div>
        </div>
      ) : null}
      {llmProviderFieldVisible ? (
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="edit-agent-llm-provider"
          >
            LLM provider
            {providerRequired ? (
              <span className="ml-1 text-destructive" aria-hidden="true">
                *
              </span>
            ) : (
              <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
            )}
          </label>
          <PersonaDropdownField
            disabled={isPending}
            id="edit-agent-llm-provider"
            onValueChange={onProviderChange}
            options={providerDropdownOptions}
            placeholder="Default (auto)"
            value={providerSelectValue}
          />
          {isCustomProviderEditing ? (
            <div
              className={cn(
                "mt-2 flex min-h-11 items-center px-3",
                PERSONA_FIELD_SHELL_CLASS,
              )}
            >
              <Input
                aria-label="Custom provider ID"
                autoCorrect="off"
                className={cn(
                  "h-8 px-0 py-0 leading-6",
                  PERSONA_FIELD_CONTROL_CLASS,
                )}
                disabled={isPending}
                id="edit-agent-custom-provider"
                onChange={(event) => onProviderIdChange(event.target.value)}
                placeholder="Custom provider ID"
                value={provider}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {llmProviderFieldVisible && topLevelSecretEnvVar ? (
        <PersonaProviderApiKeyField
          disabled={isPending}
          envVarName={topLevelSecretEnvVar}
          isInherited={apiKeyIsInherited}
          inheritedLabel={apiKeyInheritedLabel}
          isRequired={apiKeyIsRequired}
          label={getProviderApiKeyLabel(effectiveProvider) ?? "API Key"}
          onValueChange={(next) => {
            onEnvVarsChange((previous) => ({
              ...previous,
              [topLevelSecretEnvVar]: next,
            }));
          }}
          value={apiKeyValue}
        />
      ) : null}
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="edit-agent-model"
        >
          Model
          {modelRequired ? (
            <span className="ml-1 text-destructive" aria-hidden="true">
              *
            </span>
          ) : (
            <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
          )}
        </label>
        <PersonaDropdownField
          disabled={isPending || modelDiscoveryLoading}
          id="edit-agent-model"
          onValueChange={onModelChange}
          options={modelDropdownOptions}
          placeholder="Default model"
          value={modelSelectValue}
        />
        {showCustomModelInput ? (
          <div
            className={cn(
              "mt-2 flex min-h-11 items-center px-3",
              PERSONA_FIELD_SHELL_CLASS,
            )}
          >
            <Input
              aria-label="Custom model ID"
              autoCorrect="off"
              className={cn(
                "h-8 px-0 py-0 leading-6",
                PERSONA_FIELD_CONTROL_CLASS,
              )}
              disabled={isPending}
              id="edit-agent-custom-model"
              onChange={(event) => onModelIdChange(event.target.value)}
              placeholder="Custom model ID"
              value={model}
            />
          </div>
        ) : null}
        {modelStatusMessage ? (
          <p className="text-xs text-muted-foreground">{modelStatusMessage}</p>
        ) : null}
      </div>
      <AgentAiDefaultsNotice
        onEditDefaults={() => onAiDefaultsOpenChange(true)}
        triggerRef={aiDefaultsTriggerRef}
        explicitModel={explicitModel}
        explicitProvider={explicitProvider}
        inheritedModel={inheritedModelDefault}
        inheritedProvider={inheritedProviderDefault}
      />
      <AgentDefaultsDialog
        onOpenChange={onAiDefaultsOpenChange}
        open={aiDefaultsOpen}
        returnFocusRef={aiDefaultsTriggerRef}
      />
      <div className="space-y-3">
        <button
          aria-expanded={showAdvancedFields}
          className="inline-flex h-9 items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-foreground/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onShowAdvancedFieldsChange((current) => !current)}
          type="button"
        >
          <span>Advanced</span>
          <AdvancedRequiredBadge
            envVars={effectiveEnvVars}
            requiredEnvKeys={advancedRequiredEnvKeys}
            testId="edit-agent-advanced-required-badge"
          />
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-150 ease-out",
              showAdvancedFields && "rotate-180",
            )}
          />
        </button>
        <AnimatePresence initial={false}>
          {showAdvancedFields ? (
            <motion.div
              animate={{ height: "auto", opacity: 1, scale: 1 }}
              className="origin-top overflow-hidden"
              exit={{ height: 0, opacity: 0, scale: 0.98 }}
              initial={{ height: 0, opacity: 0, scale: 0.98 }}
              key="edit-agent-advanced-fields"
              transition={advancedFieldsTransition}
            >
              <EditAgentAdvancedFields
                acpCommand={acpCommand}
                agentArgs={agentArgs}
                autoRestartOnConfigChange={autoRestartOnConfigChange}
                disabled={isPending}
                envVars={envVars}
                fileSatisfiedEnvKeys={fileSatisfiedEnvKeys}
                hiddenEnvKeys={
                  topLevelSecretEnvVar ? [topLevelSecretEnvVar] : []
                }
                focusKey={
                  initialFocus?.type === "env_key"
                    ? initialFocus.key
                    : undefined
                }
                inheritedEnvVars={inheritedEnvVarsForAdvanced}
                inheritHarness={inheritHarness}
                linkedPersona={linkedPersona}
                model={explicitModel}
                modelTuningRuntimeId={prospectiveRuntimeId}
                parallelism={parallelism}
                provider={effectiveProvider}
                requiredEnvKeys={advancedRequiredEnvKeys}
                catalogStatus={runtimeCatalogStatus}
                selectedRuntime={prospectiveRuntime}
                systemPrompt={systemPrompt}
                onAcpCommandChange={onAcpCommandChange}
                onAgentArgsChange={onAgentArgsChange}
                onAutoRestartChange={onAutoRestartChange}
                onEnvVarsChange={onEnvVarsChange}
                onInheritHarnessChange={onInheritHarnessChange}
                onParallelismChange={onParallelismChange}
                onSystemPromptChange={onSystemPromptChange}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
}
