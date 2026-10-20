// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { selectorFor } from "../src/fill/driver";

describe("selectorFor on Greenhouse markup (Instawork, 2026-10-21)", () => {
  it("finds a plain field, and a multi-choice question drawn as a checkbox group", () => {
    document.body.innerHTML = `
      <input id="question_1" />
      <fieldset class="checkbox" id="question_2[]">
        <input type="checkbox" id="question_2[]_10" name="question_2[]" /><label for="question_2[]_10">AWS</label>
        <input type="checkbox" id="question_2[]_11" name="question_2[]" /><label for="question_2[]_11">GCP</label>
      </fieldset>`;
    expect(document.querySelector(selectorFor("question_1"))?.tagName).toBe(
      "INPUT",
    );
    const group = document.querySelector(selectorFor("question_2"));
    expect(group?.tagName).toBe("FIELDSET");
    expect(group?.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
  });
});
