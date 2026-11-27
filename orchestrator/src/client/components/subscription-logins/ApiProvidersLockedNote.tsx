/** Shown to non-admins above the (disabled) provider/API key settings. */
export function ApiProvidersLockedNote() {
  return (
    <p
      className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
      data-testid="api-providers-locked-note"
    >
      API providers, base URLs and API keys are managed by your workspace admin.
      You can still run your tasks on your own Claude or ChatGPT subscription
      from Subscription logins above.
    </p>
  );
}
