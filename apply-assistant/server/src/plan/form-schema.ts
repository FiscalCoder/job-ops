import { createHash } from "node:crypto";

/**
 * The form description every application system's parser produces and the planner works on:
 * one flat field list, whatever the system.
 */

export type FieldType =
  | "text"
  | "textarea"
  | "file"
  | "select"
  | "multiselect"
  | "hidden"
  | "unknown";

export type FieldSection =
  | "main"
  | "location"
  | "compliance"
  | "demographic"
  | "education";

export interface FieldOption {
  readonly label: string;
  readonly value: string;
}

export interface FormField {
  /** The page's own name for the field: how the driver finds it. */
  readonly ref: string;
  /**
   * Shared meaning when the system's name differs (Ashby "_systemfield_name" = "full_name"), so
   * one set of rules answers every system. Greenhouse's names are already the shared ones.
   */
  readonly canonical?: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly options: readonly FieldOption[];
  readonly section: FieldSection;
}

export interface FormSchema {
  readonly postingId: string;
  readonly title: string;
  readonly location: string;
  readonly education: "required" | "optional" | null;
  readonly fields: readonly FormField[];
  readonly hash: string;
}

/** Short content hash: changes when the form's fields change. */
export const schemaHash = (content: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex")
    .slice(0, 16);
