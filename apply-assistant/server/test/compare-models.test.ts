import { describe, expect, it } from "vitest";
import {
  compareActSteps,
  compareDeepRead,
  replyJson,
  restoreImages,
} from "../src/tools/compare-models.js";

const reply = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

describe("comparing a cheaper model's answers with the ones used", () => {
  it("reads a reply's JSON", () => {
    expect(replyJson(reply({ a: 1 }))).toEqual({ a: 1 });
    expect(replyJson({ content: [{ type: "text", text: "not json" }] })).toBeNull();
  });

  it("scores closer reads by fields with the same meaning and input", () => {
    const used = { fields: [{ ref: "a", meaning: "phone", input: "text" }, { ref: "b", meaning: "city", input: "search" }] };
    expect(compareDeepRead(used, used)).toMatchObject({ same: true, score: 1 });
    const other = { fields: [{ ref: "a", meaning: "phone", input: "text" }, { ref: "b", meaning: "state", input: "search" }] };
    const result = compareDeepRead(used, other);
    expect(result).toMatchObject({ same: false, score: 0.5 });
    expect(result.note).toContain("b: city|search vs state|search");
  });

  it("scores widget steps in order", () => {
    const used = { steps: [{ action: "click", value: "#x" }, { action: "pick", value: "{value}" }] };
    expect(compareActSteps(used, used)).toMatchObject({ same: true, score: 1 });
    const other = { steps: [{ action: "click", value: "#x" }, { action: "type", value: "{value}" }] };
    expect(compareActSteps(used, other)).toMatchObject({ same: false, score: 0.5 });
  });

  it("puts saved screenshots back into a logged request", () => {
    const logged = {
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", file: "img-1.jpg", bytes: 9 } }] }],
    };
    expect(restoreImages(logged, (file) => `data-of-${file}`)).toEqual({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "data-of-img-1.jpg" } }] }],
    });
  });
});
