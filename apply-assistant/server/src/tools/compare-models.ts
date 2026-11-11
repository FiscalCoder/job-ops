/**
 * Would a cheaper model do as well? Re-sends logged Claude calls (ai_calls: exactly what was sent,
 * screenshots included) to another model and compares its answers with what was used.
 *
 * Run inside the apply-assistant container once some runs are logged:
 *   node --import tsx server/src/tools/compare-models.ts [--purpose deep-read,act-field]
 *     [--model claude-haiku-5-5] [--limit 20] [--dry-run]
 *
 * It spends real API money (the server's key; Haiku: about $0.002 a closer read). --dry-run
 * only counts what it would send. The report goes to <data>/ai-calls/compare-<time>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { usageOfMessage } from "../claude/pricing.js";

export interface Agreement {
  readonly same: boolean;
  /** 0 to 1: how much of the two answers agrees. */
  readonly score: number;
  readonly note: string;
}

/** A reply's JSON (structured output text); null when it isn't JSON. */
export function replyJson(message: unknown): unknown {
  const content = (message as { content?: { type: string; text?: string }[] })?.content ?? [];
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Closer reads: the share of fields given the same meaning and input kind. */
export function compareDeepRead(used: unknown, other: unknown): Agreement {
  const fields = (v: unknown) =>
    new Map(
      ((v as { fields?: { ref: string; meaning: string; input: string }[] })?.fields ?? []).map(
        (f) => [f.ref, `${f.meaning}|${f.input}`],
      ),
    );
  const a = fields(used);
  const b = fields(other);
  const refs = new Set([...a.keys(), ...b.keys()]);
  if (refs.size === 0) return { same: true, score: 1, note: "no fields in either" };
  const agree = [...refs].filter((r) => a.get(r) === b.get(r)).length;
  const differ = [...refs].filter((r) => a.get(r) !== b.get(r)).slice(0, 5);
  return {
    same: agree === refs.size,
    score: agree / refs.size,
    note: differ.length
      ? `differs on ${differ.map((r) => `${r}: ${a.get(r) ?? "-"} vs ${b.get(r) ?? "-"}`).join("; ")}`
      : "same",
  };
}

const stepText = (v: unknown) =>
  ((v as { steps?: { action: string; value: string }[] })?.steps ?? []).map(
    (s) => `${s.action} ${s.value.trim().toLowerCase()}`,
  );

/** Widget steps: the same steps, or how many of them in order match. */
export function compareActSteps(used: unknown, other: unknown): Agreement {
  const a = stepText(used);
  const b = stepText(other);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return { same: true, score: 1, note: "no steps from either" };
  const inOrder = a.filter((s, i) => b[i] === s).length;
  return {
    same: a.length === b.length && inOrder === a.length,
    score: inOrder / longest,
    note: inOrder === longest ? "same" : `used: ${a.join(" → ")} | other: ${b.join(" → ")}`,
  };
}

/** A logged request with each saved image put back in place of its file name. */
export function restoreImages(value: unknown, read: (file: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => restoreImages(v, read));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "base64" && typeof record.file === "string") {
    const { file, bytes: _bytes, ...rest } = record;
    return { ...rest, data: read(file) };
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, restoreImages(v, read)]));
}

const COMPARE: Record<string, (used: unknown, other: unknown) => Agreement> = {
  "deep-read": compareDeepRead,
  "act-field": compareActSteps,
};

interface CallRow {
  id: string;
  purpose: string;
  model: string;
  cost: number | null;
  field_label: string | null;
  payload_file: string;
  created_at: string;
}

async function main() {
  const arg = (name: string, fallback: string) => {
    const at = process.argv.indexOf(`--${name}`);
    return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
  };
  const purposes = arg("purpose", "deep-read,act-field").split(",").filter((p) => p in COMPARE);
  const model = arg("model", "claude-haiku-5-5");
  const limit = Number(arg("limit", "20"));
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = process.env.APPLY_DATA_DIR ?? "/data";
  const dir = path.join(dataDir, "ai-calls");
  // Reads only (the server keeps writing; WAL lets both).
  const db = new DatabaseSync(path.join(dataDir, "apply.db"));
  const rows = db
    .prepare(
      `select id, purpose, model, cost, field_label, payload_file, created_at from ai_calls
        where payload_file is not null and error is null and model not like ?
          and purpose in (${purposes.map(() => "?").join(",")})
        order by created_at desc limit ?`,
    )
    .all(`${model}%`, ...purposes, limit) as unknown as CallRow[];
  console.log(`${rows.length} logged call(s) to re-send to ${model} (${purposes.join(", ")})`);
  if (dryRun || rows.length === 0) return;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY isn't set");
  const client = new Anthropic({ apiKey: key });
  type Result =
    | ({
        id: string;
        purpose: string;
        label: string | null;
        usedModel: string;
        usedCost: number | null;
        otherCost: number | null;
      } & Agreement)
    | { id: string; purpose: string; error: string };
  const results: Result[] = [];
  for (const row of rows) {
    const payload = JSON.parse(gunzipSync(readFileSync(path.join(dir, row.payload_file))).toString("utf8")) as {
      request: Record<string, unknown>;
      response: unknown;
    };
    const request = restoreImages(payload.request, (file) =>
      readFileSync(path.join(dir, file)).toString("base64"),
    ) as Anthropic.MessageCreateParamsNonStreaming;
    try {
      const message = await client.messages.create({ ...request, model });
      const compare = COMPARE[row.purpose] ?? compareDeepRead;
      const agreement = compare(replyJson(payload.response), replyJson(message));
      results.push({
        id: row.id,
        purpose: row.purpose,
        label: row.field_label,
        usedModel: row.model,
        usedCost: row.cost,
        otherCost: usageOfMessage(message).cost,
        ...agreement,
      });
      console.log(`${row.purpose} ${row.field_label ?? ""}: ${agreement.same ? "same" : `${Math.round(agreement.score * 100)}%`}`);
    } catch (error) {
      results.push({ id: row.id, purpose: row.purpose, error: String(error) });
    }
  }
  const byPurpose = purposes.map((purpose) => {
    const done = results.filter((r) => r.purpose === purpose && "score" in r) as {
      same: boolean;
      score: number;
      usedCost: number | null;
      otherCost: number | null;
    }[];
    const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
    return {
      purpose,
      calls: done.length,
      sameAnswer: done.filter((r) => r.same).length,
      averageAgreement: done.length ? sum(done.map((r) => r.score)) / done.length : null,
      usedCost: sum(done.map((r) => r.usedCost)),
      otherCost: sum(done.map((r) => r.otherCost)),
    };
  });
  const report = path.join(dir, `compare-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(report, JSON.stringify({ model, byPurpose, results }, null, 2));
  console.log(JSON.stringify(byPurpose, null, 2));
  console.log(`Report: ${report}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
