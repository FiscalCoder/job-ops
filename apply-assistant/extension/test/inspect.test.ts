// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WatchMessage, watchForm } from "../src/track/inspect";

const sent: WatchMessage[] = [];
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: async (message: WatchMessage) => {
      sent.push(message);
    },
  },
});

afterEach(() => {
  document.body.innerHTML = "";
  sent.length = 0;
  delete (window as unknown as { __applyCopilotWatch?: boolean })
    .__applyCopilotWatch;
});

const page = () => `
  <h2 data-automation-id="pageHeader">My Information</h2>
  <div data-automation-id="formField-legalNameSection_firstName">
    <label for="first">First Name</label>
    <input id="first" data-automation-id="legalNameSection_firstName" required>
  </div>
  <label for="pw">Password</label><input id="pw" type="password">
  <fieldset><legend>Previously worked here?</legend>
    <label><input type="radio" name="prev" value="yes"> Yes</label>
    <label><input type="radio" name="prev" value="no"> No</label>
  </fieldset>
  <label for="src">How did you hear?</label>
  <button id="src" aria-haspopup="listbox" data-automation-id="sourceDropdown">LinkedIn</button>
  <label for="country">Country</label>
  <select id="country"><option>India</option><option>Peru</option></select>
  <button data-automation-id="bottom-navigation-next-button">Save and Continue</button>
  <button>Add Another</button>`;

describe("watchForm", () => {
  it("lists the page's fields with labels, automation ids and answers, never passwords", () => {
    document.body.innerHTML = page();
    (document.getElementById("first") as HTMLInputElement).value = "Test";
    (document.getElementById("pw") as HTMLInputElement).value = "hunter2";
    (document.querySelector("input[value=no]") as HTMLInputElement).checked =
      true;
    const result = watchForm(false);
    expect(result.heading).toBe("My Information");
    const byLabel = (label: string) =>
      result.fields.find((f) => f.label === label);
    expect(byLabel("First Name")).toMatchObject({
      automationId: "legalNameSection_firstName",
      required: true,
      value: "Test",
    });
    expect(byLabel("Password")?.value).toBe("");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.fields.filter((f) => f.type === "radio")).toEqual([
      expect.objectContaining({ options: ["Yes", "No"], value: ["No"] }),
    ]);
    expect(byLabel("How did you hear?")).toMatchObject({
      type: "dropdown",
      automationId: "sourceDropdown",
      value: "LinkedIn",
    });
    expect(byLabel("Country")).toMatchObject({
      type: "select",
      options: ["India", "Peru"],
      value: ["India"],
    });
  });

  it("reports each answer you change, and the whole page when you click a step button", async () => {
    document.body.innerHTML = page();
    watchForm(true);
    watchForm(true); // installs its listeners once
    const first = document.getElementById("first") as HTMLInputElement;
    first.value = "Ada";
    first.dispatchEvent(new Event("change", { bubbles: true }));
    (
      document.querySelector("button:not([aria-haspopup])") as HTMLButtonElement
    ).click();
    (document.querySelectorAll("button")[2] as HTMLButtonElement).click(); // "Add Another": not a step
    await Promise.resolve();
    expect(sent.map((m) => m.type)).toEqual(["manual-field", "manual-step"]);
    expect(sent[0]).toMatchObject({
      field: { label: "First Name", value: "Ada" },
    });
    const step = sent[1] as Extract<WatchMessage, { type: "manual-step" }>;
    expect(step.button).toBe("Save and Continue");
    expect(step.page.fields.find((f) => f.label === "First Name")?.value).toBe(
      "Ada",
    );
  });
});
