import { currentUser, currentUserIsAdmin } from "../store/owner.js";
import type { UserSettingsRepo } from "../store/user-settings-repo.js";
import type { MessagesApi } from "./answerer.js";

/**
 * Whose Claude key a call uses: the signed-in user's own (saved in Apply Copilot's settings);
 * for Job Ops' admin, the server's key when they haven't saved one. Anyone else without a
 * key has Claude off: rules, the answer bank and the resume still fill their forms.
 */

export class ClaudeKeyMissingError extends Error {
  constructor() {
    super(NO_KEY);
    this.name = "ClaudeKeyMissingError";
  }
}

const NO_KEY =
  "Add your Claude API key in Apply Copilot (Settings) to have Claude answer this";

export type ClaudeKeySource = "yours" | "server" | null;

export function createClaudeAccess(deps: {
  readonly settings: UserSettingsRepo;
  /** The server's own key (its admin's); null without one. */
  readonly serverMessages: MessagesApi | null;
  readonly messagesFor: (apiKey: string) => MessagesApi;
}) {
  const clients = new Map<string, MessagesApi>();
  const clientFor = (apiKey: string) => {
    const known = clients.get(apiKey);
    if (known) return known;
    const made = deps.messagesFor(apiKey);
    clients.set(apiKey, made);
    return made;
  };

  const source = (): ClaudeKeySource =>
    deps.settings.claudeKey(currentUser())
      ? "yours"
      : currentUserIsAdmin() && deps.serverMessages
        ? "server"
        : null;

  return {
    source,
    /** Why Claude is off for the signed-in user; null when it's on. */
    unavailable: (): string | null => (source() ? null : NO_KEY),
    /** Claude's API as the signed-in user: their key, or (admin) the server's. */
    messages: {
      create(params) {
        const own = deps.settings.claudeKey(currentUser());
        if (own) return clientFor(own).create(params);
        if (currentUserIsAdmin() && deps.serverMessages)
          return deps.serverMessages.create(params);
        return Promise.reject(new ClaudeKeyMissingError());
      },
    } satisfies MessagesApi,
  };
}

export type ClaudeAccess = ReturnType<typeof createClaudeAccess>;
