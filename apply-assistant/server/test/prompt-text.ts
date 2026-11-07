/** A request's prompt or system as one text: a plain string, or its text blocks in order. */
export function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
      .join("\n\n");
  return String(content);
}
