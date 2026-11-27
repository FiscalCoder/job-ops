import { ChevronDown, ChevronRight } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ClaudeTokenFallbackProps {
  disabled: boolean;
  isSaving: boolean;
  onSave: (token: string) => Promise<boolean>;
}

const TOKEN_INPUT_ID = "claude-setup-token";

export function ClaudeTokenFallback({
  disabled,
  isSaving,
  onSave,
}: ClaudeTokenFallbackProps) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    const ok = await onSave(trimmed);
    // Never keep a pasted secret around longer than needed.
    setToken("");
    if (ok) setOpen(false);
  };

  return (
    <div className="text-xs">
      <button
        type="button"
        className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
        Use a token instead
      </button>
      {open ? (
        <form
          className="mt-2 space-y-2 rounded-md border border-dashed border-border/70 p-3"
          onSubmit={(event) => void submit(event)}
        >
          <p className="text-muted-foreground">
            On any computer with Claude Code installed, run{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              claude setup-token
            </code>
            , sign in, and paste the token it prints (it starts with{" "}
            <code className="rounded bg-muted px-1 py-0.5">sk-ant-oat</code>).
          </p>
          <label htmlFor={TOKEN_INPUT_ID} className="font-medium">
            Claude token
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={TOKEN_INPUT_ID}
              type="password"
              value={token}
              autoComplete="off"
              placeholder="sk-ant-oat..."
              className="h-9 max-w-sm font-mono"
              onChange={(event) => setToken(event.target.value)}
              disabled={disabled || isSaving}
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={disabled || isSaving || !token.trim()}
            >
              {isSaving ? "Saving..." : "Save token"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
