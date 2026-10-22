import type {
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { OperateRequest, OperateShot, OperateTurn } from "../lib/api";
import { focusCheck, type Inspection, inspectTarget, outlineField } from "./operate-page";
import { sleep } from "./options";
import { type ActStep, pickOpenChoice, type SiteHelp, showsValue } from "./site-help";
import type { PlanEntry } from "./supervisor";
import type { FillOutcome } from "./trusted";

/**
 * "Let Claude do it": Claude sets one field by working the page like a person. Each turn it
 * gets a screenshot and an outline of the field's area (operate-page.ts); its actions (the
 * computer toolset's clicks, typing and keys, or the element tool on an outline ref) are
 * carried out here with trusted input, each one checked first: no submit / continue / delete,
 * nothing outside the field, no password fields, allowed keys only. A page that moves stops
 * it, and so does Stop (on the page or Pause in the side panel). The field is read back at the
 * end; what worked is saved as this site's steps, so next time Claude isn't needed.
 */

/** Claude's side of the loop (the server keeps the conversation, limits and cost). */
export interface OperateApi {
  turn(body: OperateRequest): Promise<OperateTurn>;
  stop(session: string): Promise<void>;
}

export interface OperateTarget {
  readonly page: Page;
  readonly frame: Frame;
  /** CSS selector of the field (or its container). */
  readonly selector: string;
  readBack(): Promise<string>;
}

const FORBIDDEN = String.raw`\b(submit|apply|save|continue|next|send|finish|delete|remove|upload|sign ?in|log ?in)\b`;
const MAX_SHOT = { width: 1280, height: 800 };
const OUTLINE_LIMIT = 60;
const MAX_WAIT_S = 2;
const NOT_RUN = "Not executed: an earlier computer action in this turn failed.";

/** Keys Claude may press (xdotool names, as the toolset sends them), as puppeteer names. */
const KEYS: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  space: " ",
};
/** The keys a saved step may press (as site-help runs them). */
const STEP_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace"]);

interface Done {
  readonly ok: boolean;
  readonly text?: string;
  readonly screenshot?: OperateShot;
}

const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export async function operateField(
  target: OperateTarget,
  entry: PlanEntry,
  wanted: string,
  failure: string,
  api: OperateApi,
  options: { readonly help: SiteHelp | null; readonly stopped: () => boolean },
): Promise<FillOutcome> {
  const { page, frame } = target;
  const here = () => page.url().split("#")[0];
  const startUrl = here();
  /** Screenshot pixels per CSS pixel, from the latest full screenshot (Claude's coordinates). */
  let scale = 1;
  const steps: ActStep[] = [];
  let learnable = true;
  let actions = 0;

  const viewport = () => page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

  /** The viewport (or a part of it, in CSS pixels), at most MAX_SHOT, as JPEG. */
  async function capture(region?: { x: number; y: number; w: number; h: number }) {
    const view = await viewport();
    const raw = (await page.screenshot({ type: "jpeg", quality: 85, encoding: "base64" })) as string;
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/jpeg;base64,${raw}`)).blob(),
    );
    const dpr = bitmap.width / view.w;
    const part = region ?? { x: 0, y: 0, w: view.w, h: view.h };
    const fit = Math.min(MAX_SHOT.width / part.w, MAX_SHOT.height / part.h, region ? 4 : 1);
    const width = Math.max(1, Math.round(part.w * fit));
    const height = Math.max(1, Math.round(part.h * fit));
    const canvas = new OffscreenCanvas(width, height);
    canvas
      .getContext("2d")
      ?.drawImage(bitmap, part.x * dpr, part.y * dpr, part.w * dpr, part.h * dpr, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    if (!region) scale = fit;
    return { data: await toBase64(blob), mediaType: "image/jpeg" as const };
  }

  const frameOffset = async (f: Frame) => {
    const element = await f.frameElement();
    const box = element ? await element.boundingBox() : null;
    return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
  };

  const outline = async () =>
    frame
      .evaluate(
        outlineField,
        target.selector,
        (await frameOffset(frame))?.x ?? 0,
        (await frameOffset(frame))?.y ?? 0,
        scale,
        OUTLINE_LIMIT,
      )
      .catch((error: unknown) => `(no outline: ${error instanceof Error ? error.message : String(error)})`);

  /** The frame under a point (CSS pixels of the tab), and the point inside it. */
  async function frameAt(x: number, y: number) {
    let best = { frame: page.mainFrame(), x, y, area: Number.POSITIVE_INFINITY };
    for (const f of page.frames()) {
      const box = await frameOffset(f).catch(() => null);
      if (!box || x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h) continue;
      if (box.w * box.h < best.area) best = { frame: f, x: x - box.x, y: y - box.y, area: box.w * box.h };
    }
    return best;
  }

  async function focusedFrame(): Promise<Frame> {
    for (const f of page.frames().slice().reverse())
      if (await f.evaluate(() => document.hasFocus() && document.activeElement?.tagName !== "IFRAME").catch(() => false))
        return f;
    return frame;
  }

  const learn = (inspection: Inspection) => {
    if (inspection.learn)
      steps.push({
        ...inspection.learn,
        value: inspection.learn.value.split(wanted).join("{value}"),
      });
    else learnable = false;
  };

  const point = (input: { coordinate?: unknown }) => {
    const c = input.coordinate;
    if (!Array.isArray(c) || c.length !== 2 || !c.every((v) => typeof v === "number")) return null;
    return { x: (c[0] as number) / scale, y: (c[1] as number) / scale };
  };

  async function click(input: { coordinate?: unknown; text?: unknown }, count: number): Promise<Done> {
    if (input.text) return { ok: false, text: "Refused: no modifier keys" };
    const at = point(input);
    if (!at) return { ok: false, text: "A coordinate [x, y] is needed" };
    const hit = await frameAt(at.x, at.y);
    const inspection = await hit.frame
      .evaluate(inspectTarget, "point", hit.x, hit.y, FORBIDDEN)
      .catch(() => ({ refused: "Couldn't check what's there", learn: null }) as Inspection);
    if (inspection.refused) return { ok: false, text: inspection.refused };
    await page.mouse.click(at.x, at.y, { count });
    if (count === 1) learn(inspection);
    else learnable = false;
    return { ok: true };
  }

  async function type(text: string): Promise<Done> {
    const refused = await (await focusedFrame()).evaluate(focusCheck, false).catch(() => "Couldn't check the focus");
    if (refused) return { ok: false, text: refused };
    await page.keyboard.sendCharacter(text.slice(0, 2_000));
    steps.push({ action: "type", value: text.split(wanted).join("{value}") });
    return { ok: true };
  }

  async function key(input: { text?: unknown; repeat?: unknown }): Promise<Done> {
    const combo = String(input.text ?? "").toLowerCase().replace(/\s+/g, "");
    const repeat = Math.min(Math.max(Number(input.repeat) || 1, 1), 10);
    if (combo === "ctrl+a") {
      const refused = await (await focusedFrame()).evaluate(focusCheck, false).catch(() => "Couldn't check the focus");
      if (refused) return { ok: false, text: refused };
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      learnable = false;
      return { ok: true };
    }
    const name = KEYS[combo];
    if (!name) return { ok: false, text: `Refused: the ${input.text} key isn't allowed here` };
    if (name === "Enter") {
      const refused = await (await focusedFrame()).evaluate(focusCheck, true).catch(() => "Couldn't check the focus");
      if (refused) return { ok: false, text: refused };
    }
    for (let i = 0; i < repeat; i++) {
      await page.keyboard.press(name as "Enter");
      if (STEP_KEYS.has(name)) steps.push({ action: "press", value: name });
      else learnable = false;
    }
    return { ok: true };
  }

  async function element(input: { ref?: unknown; action?: unknown; text?: unknown }): Promise<Done> {
    const ref = String(input.ref ?? "");
    const text = typeof input.text === "string" ? input.text : "";
    if (input.action === "pick") {
      const picked = await pickOpenChoice(frame, text);
      if (!picked) return { ok: false, text: `No open list shows "${text}"` };
      steps.push({ action: "pick", value: text.split(wanted).join("{value}") });
      return { ok: true, text: `Picked "${picked}"` };
    }
    if (input.action !== "click" && input.action !== "type")
      return { ok: false, text: "action is click, type or pick" };
    const handle = await frame.$(`[data-ac-el="${ref.replace(/["\\]/g, "")}"]`);
    if (!handle) return { ok: false, text: `No element ${ref} (take a screenshot for a fresh outline)` };
    const inspection = await frame
      .evaluate(inspectTarget, "ref", ref, 0, FORBIDDEN)
      .catch(() => ({ refused: "Couldn't check that element", learn: null }) as Inspection);
    if (inspection.refused) return { ok: false, text: inspection.refused };
    await handle.click().catch(() => handle.evaluate((el) => (el as HTMLElement).click()));
    learn(inspection);
    if (input.action === "click") return { ok: true };
    const refused = await frame.evaluate(focusCheck, false).catch(() => "Couldn't check the focus");
    if (refused) return { ok: false, text: refused };
    await handle.evaluate((el) => (el as HTMLInputElement).select?.());
    await page.keyboard.press("Backspace");
    await page.keyboard.sendCharacter(text.slice(0, 2_000));
    steps.push({ action: "type", value: text.split(wanted).join("{value}") });
    return { ok: true };
  }

  /** One of Claude's actions, checked first. */
  async function run(call: OperateTurn["calls"][number]): Promise<Done> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    actions += 1;
    if (!call.toolset) return call.name === "element" ? element(input) : { ok: false, text: "Unknown tool" };
    switch (call.name) {
      case "screenshot": {
        const shot = await capture();
        return { ok: true, screenshot: shot, text: `Outline:\n${await outline()}` };
      }
      case "zoom": {
        const r = input.region;
        if (!Array.isArray(r) || r.length !== 4) return { ok: false, text: "region [x0, y0, x1, y1] is needed" };
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = (r as number[]).map((v) => Number(v) / scale);
        if (!(x1 > x0 && y1 > y0)) return { ok: false, text: "An empty region" };
        return { ok: true, screenshot: await capture({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }) };
      }
      case "left_click":
        return click(input, 1);
      case "double_click":
        return click(input, 2);
      case "triple_click":
        return click(input, 3);
      case "mouse_move": {
        const at = point(input);
        if (!at) return { ok: false, text: "A coordinate [x, y] is needed" };
        await page.mouse.move(at.x, at.y);
        return { ok: true };
      }
      case "scroll": {
        const at = point(input) ?? { x: 0, y: 0 };
        if (input.text) return { ok: false, text: "Refused: no modifier keys" };
        const amount = Math.min(Number(input.scroll_amount) || 1, 10) * 100;
        const dir = String(input.scroll_direction);
        await page.mouse.move(at.x, at.y);
        await page.mouse.wheel({
          deltaX: dir === "left" ? -amount : dir === "right" ? amount : 0,
          deltaY: dir === "up" ? -amount : dir === "down" ? amount : 0,
        });
        return { ok: true };
      }
      case "type":
        return type(String(input.text ?? ""));
      case "key":
        return key(input);
      case "wait":
        await sleep(Math.min(Number(input.duration) || 0, MAX_WAIT_S) * 1000);
        steps.push({ action: "wait", value: "500" });
        return { ok: true };
      default:
        return { ok: false, text: `Refused: ${call.name} isn't available here` };
    }
  }

  const stopPressed = () =>
    page
      .evaluate(() => (window as unknown as { __acOperateStop?: boolean }).__acOperateStop === true)
      .catch(() => false);

  await banner(page, true);
  let session: string | null = null;
  try {
    const screenshot = await capture();
    let turn = await api.turn({
      label: entry.label,
      wanted,
      failure,
      outline: await outline(),
      screenshot,
    });
    session = turn.session;
    while (!turn.done) {
      const results: { id: string; ok: boolean; text?: string; screenshot?: OperateShot }[] = [];
      let failed = false;
      for (const call of turn.calls) {
        if (failed) {
          results.push({ id: call.id, ok: false, text: NOT_RUN });
          continue;
        }
        if (options.stopped() || (await stopPressed()))
          return { ok: false, reason: "You stopped Claude" };
        const done = await run(call).catch(
          (error: unknown): Done => ({
            ok: false,
            text: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
        results.push({ id: call.id, ...done, text: done.text ?? (done.ok ? "OK" : "Not done") });
        if (!done.ok) failed = true;
        await sleep(120);
        if (here() !== startUrl)
          return { ok: false, reason: "The page moved while Claude worked; it stopped" };
      }
      turn = await api.turn({ session: turn.session, results });
    }
    session = null;
    await sleep(200);
    const shown = await target.readBack();
    if (!showsValue(shown, wanted))
      return {
        ok: false,
        reason: `Claude couldn't set it${turn.why ? `: ${turn.why}` : ""}`,
      };
    if (options.help && learnable && steps.some((s) => s.action !== "wait"))
      await options.help.record(entry.label, steps.slice(0, 8), true).catch(() => {});
    return {
      ok: true,
      result: `set by Claude (${actions} actions, about $${turn.cost.toFixed(2)})`,
    };
  } finally {
    if (session) await api.stop(session).catch(() => {});
    await banner(page, false);
  }
}

/** "Claude is operating this field" with a Stop button, on the page while it works. */
function banner(page: Page, on: boolean) {
  return page
    .evaluate((show) => {
      const w = window as unknown as { __acOperateStop?: boolean };
      document.getElementById("ac-operate-banner")?.remove();
      w.__acOperateStop = false;
      if (!show) return;
      const bar = document.createElement("div");
      bar.id = "ac-operate-banner";
      bar.setAttribute(
        "style",
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1b1f24;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:6px 8px 6px 12px;border-radius:8px;box-shadow:0 2px 8px #0004;display:flex;gap:10px;align-items:center",
      );
      bar.textContent = "Claude is operating this field";
      const stop = document.createElement("button");
      stop.textContent = "Stop";
      stop.setAttribute("style", "font:inherit;padding:2px 10px;border-radius:6px;border:0;cursor:pointer");
      stop.addEventListener("click", () => {
        w.__acOperateStop = true;
        bar.textContent = "Stopping…";
      });
      bar.append(stop);
      document.body.append(bar);
    }, on)
    .catch(() => {});
}
