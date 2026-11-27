import type { LlmPurpose } from "@shared/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildDefaultProviderPatch,
  buildTaskPatch,
  getDefaultProvider,
  getSavedOverrides,
  getTaskChoice,
  INHERIT_CHOICE,
  isSubscriptionProvider,
  SUBSCRIPTION_PROVIDER_LABELS,
  type SubscriptionProviderId,
  TASK_ROWS,
  type TaskChoice,
} from "./task-routing";
import type { SubscriptionSettingsController } from "./useSubscriptionSettings";

interface SubscriptionTaskRoutingProps {
  connected: Record<SubscriptionProviderId, boolean>;
  settingsController: SubscriptionSettingsController;
  disabled: boolean;
}

const OTHER_PROVIDER_VALUE = "__other__";
const PROVIDER_IDS: SubscriptionProviderId[] = ["claude_cli", "codex"];

interface ChoiceSelectProps {
  id: string;
  label: string;
  value: string;
  inheritLabel?: string;
  otherLabel?: string;
  connected: Record<SubscriptionProviderId, boolean>;
  disabled: boolean;
  onChange: (value: TaskChoice) => void;
}

function ChoiceSelect({
  id,
  label,
  value,
  inheritLabel,
  otherLabel,
  connected,
  disabled,
  onChange,
}: ChoiceSelectProps) {
  const selectValue =
    value === INHERIT_CHOICE || isSubscriptionProvider(value)
      ? value
      : OTHER_PROVIDER_VALUE;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <Select
        value={selectValue}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === OTHER_PROVIDER_VALUE) return;
          onChange(next as TaskChoice);
        }}
      >
        <SelectTrigger id={id} className="h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {inheritLabel ? (
            <SelectItem value={INHERIT_CHOICE}>{inheritLabel}</SelectItem>
          ) : null}
          {selectValue === OTHER_PROVIDER_VALUE ? (
            <SelectItem value={OTHER_PROVIDER_VALUE} disabled>
              {otherLabel ?? "Workspace provider"}
            </SelectItem>
          ) : null}
          {PROVIDER_IDS.map((provider) => (
            <SelectItem
              key={provider}
              value={provider}
              disabled={!connected[provider] && value !== provider}
            >
              {SUBSCRIPTION_PROVIDER_LABELS[provider]}
              {connected[provider] ? "" : " (not connected)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function SubscriptionTaskRouting({
  connected,
  settingsController,
  disabled,
}: SubscriptionTaskRoutingProps) {
  const { settings, save, isSaving } = settingsController;
  if (!settings) return null;
  const overrides = getSavedOverrides(settings);
  const defaultProvider = getDefaultProvider(settings);
  const busy = disabled || isSaving;
  const defaultLabel = isSubscriptionProvider(defaultProvider)
    ? SUBSCRIPTION_PROVIDER_LABELS[defaultProvider]
    : "the workspace provider";

  const changeDefault = (choice: TaskChoice) => {
    if (choice === INHERIT_CHOICE || choice === defaultProvider) return;
    void save(buildDefaultProviderPatch(choice, overrides));
  };
  const changeTask = (purpose: LlmPurpose, choice: TaskChoice) => {
    if (choice === getTaskChoice(overrides, purpose)) return;
    void save(buildTaskPatch(purpose, choice, overrides));
  };

  return (
    <div className="space-y-2" data-testid="subscription-task-routing">
      <div className="text-sm font-medium">Use for</div>
      <p className="text-xs text-muted-foreground">
        Pick which subscription runs each task. Changes save right away.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ChoiceSelect
          id="subscription-default-provider"
          label="Everything else"
          value={defaultProvider}
          otherLabel={`Workspace provider (${defaultProvider || "default"})`}
          connected={connected}
          disabled={busy}
          onChange={changeDefault}
        />
        {TASK_ROWS.map(({ purpose, label }) => (
          <ChoiceSelect
            key={purpose}
            id={`subscription-task-${purpose}`}
            label={label}
            value={getTaskChoice(overrides, purpose)}
            inheritLabel={`Same as everything else (${defaultLabel})`}
            otherLabel="Provider set by admin"
            connected={connected}
            disabled={busy}
            onChange={(choice) => changeTask(purpose, choice)}
          />
        ))}
      </div>
    </div>
  );
}
