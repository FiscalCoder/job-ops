import {
  CLAUDE_CLI_EFFORT_VALUES,
  type ClaudeCliEffort,
} from "@shared/settings-registry";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { SubscriptionSettingsController } from "./useSubscriptionSettings";

const EFFORT_LABELS: Record<ClaudeCliEffort, string> = {
  low: "Low",
  medium: "Medium (recommended)",
  high: "High",
};

interface FallbackToggleProps {
  enabled: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}

export function FallbackToggle({
  enabled,
  disabled,
  onChange,
}: FallbackToggleProps) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id="subscription-fallback"
        checked={enabled}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label="Fall back to the other subscription"
      />
      <label htmlFor="subscription-fallback" className="text-sm leading-snug">
        Fall back to the other subscription when one hits its usage limit or its
        login expires
      </label>
    </div>
  );
}

interface EffortSelectProps {
  value: ClaudeCliEffort;
  disabled: boolean;
  onChange: (value: ClaudeCliEffort) => void;
}

export function EffortSelect({ value, disabled, onChange }: EffortSelectProps) {
  return (
    <div className="space-y-1">
      <label htmlFor="claude-cli-effort" className="text-xs font-medium">
        Claude effort
      </label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next as ClaudeCliEffort)}
      >
        <SelectTrigger id="claude-cli-effort" className="h-9 max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CLAUDE_CLI_EFFORT_VALUES.map((effort) => (
            <SelectItem key={effort} value={effort}>
              {EFFORT_LABELS[effort]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Higher effort thinks longer and uses more of your Claude usage limit.
      </p>
    </div>
  );
}

interface SubscriptionPreferencesProps {
  showFallback: boolean;
  fallbackEnabled: boolean;
  showEffort: boolean;
  settingsController: SubscriptionSettingsController;
  disabled: boolean;
}

export function SubscriptionPreferences({
  showFallback,
  fallbackEnabled,
  showEffort,
  settingsController,
  disabled,
}: SubscriptionPreferencesProps) {
  const { settings, save, isSaving } = settingsController;
  if (!showFallback && !showEffort) return null;
  const busy = disabled || isSaving || !settings;
  const effort = settings?.claudeCliEffort?.value ?? "medium";
  return (
    <div className="space-y-3">
      {showFallback ? (
        <FallbackToggle
          enabled={fallbackEnabled}
          disabled={busy}
          onChange={(value) => void save({ subscriptionFallback: value })}
        />
      ) : null}
      {showEffort ? (
        <EffortSelect
          value={effort}
          disabled={busy}
          onChange={(value) => {
            if (value !== effort) void save({ claudeCliEffort: value });
          }}
        />
      ) : null}
    </div>
  );
}
