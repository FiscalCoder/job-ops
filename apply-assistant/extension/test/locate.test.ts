// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bestCountryOption, countryOf, showsCountry } from "../src/fill/countries";
import { entrySaves, installLocator, type Locator, liveControls } from "../src/fill/locate";
import { bestOption, selectionMatches } from "../src/fill/options";
import { captureDom } from "../src/trace/dom";

/** A SmartRecruiters-like page: fields inside web components, one nested in another. */
function componentPage() {
  document.body.innerHTML = `<form>
    <input id="plain" name="plain">
    <spl-input id="first"></spl-input>
    <spl-autocomplete id="city"></spl-autocomplete>
  </form>`;
  const first = document.getElementById("first")?.attachShadow({ mode: "open" });
  if (first) first.innerHTML = `<label for="i">First name</label><input id="i" name="first">`;
  const city = document.getElementById("city")?.attachShadow({ mode: "open" });
  if (city)
    city.innerHTML = `<div class="wrap"><spl-input id="inner"></spl-input>
      <ul role="listbox"><li role="option">Chennai, Tamil Nadu</li></ul></div>`;
  const inner = city?.getElementById("inner")?.attachShadow({ mode: "open" });
  if (inner) inner.innerHTML = `<input id="spl-form-element_10" aria-label="City">`;
  delete (window as unknown as { __ac?: Locator }).__ac;
  installLocator();
  return (window as unknown as { __ac: Locator }).__ac;
}

describe("the locator", () => {
  let ac: Locator;
  beforeEach(() => {
    ac = componentPage();
  });

  it("finds a field on the page itself first, the usual way", () => {
    expect(ac.one("#plain")?.id).toBe("plain");
  });

  it("finds a field inside a component, and inside one nested in another", () => {
    expect(ac.one("[name='first']")?.getAttribute("name")).toBe("first");
    expect(ac.one("#spl-form-element_10")?.getAttribute("aria-label")).toBe("City");
  });

  it("follows 'host >>> inner' as Puppeteer writes it", () => {
    expect(ac.all("#city >>> input")).toHaveLength(1);
    expect(ac.all("#first >>> input")[0]?.getAttribute("name")).toBe("first");
  });

  it("finds a list's choices open inside a component", () => {
    expect(ac.all("[role='option']").map((o) => o.textContent)).toEqual(["Chennai, Tamil Nadu"]);
  });

  it("knows a field inside a component is inside the component (its area)", () => {
    const host = document.getElementById("city") as Element;
    const input = ac.one("#spl-form-element_10") as Element;
    expect(host.contains(input)).toBe(false);
    expect(ac.contains(host, input)).toBe(true);
    expect(ac.closest(input, "spl-autocomplete")?.id).toBe("city");
    expect(ac.parent(ac.one("#i") as Element)?.id).toBe("first");
  });

  it("a bad selector finds nothing instead of throwing", () => {
    expect(ac.all("[[nope")).toEqual([]);
    expect(ac.one("[[nope")).toBeNull();
  });

  it("is installed once: a second install keeps the first", () => {
    installLocator();
    expect((window as unknown as { __ac: Locator }).__ac).toBe(ac);
  });
});

describe("fields Claude found that the reader didn't", () => {
  it("keeps a selector that finds one control, drops the rest", () => {
    componentPage();
    // jsdom lays nothing out: every element gets a size, as on a real page.
    const box = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<button id="go">Submit</button><input id="seen" data-ac-ref="ac1"><input class="twin"><input class="twin">`,
    );
    expect(
      liveControls(["#spl-form-element_10", "#go", "#seen", ".twin", "#missing", "#city >>> spl-input >>> input"]).map(([selector]) => selector),
    ).toEqual(["#spl-form-element_10"]);
    // Marked as the reader marks a field inside a component: found the usual way after.
    const city = document.getElementById("city")?.shadowRoot?.getElementById("inner")?.shadowRoot?.querySelector("input");
    expect(city?.getAttribute("data-ac-ref")).toMatch(/^acsc/);
    Element.prototype.getBoundingClientRect = box;
  });
});

describe("countries in dropdowns", () => {
  it("knows a country however it's written", () => {
    expect(countryOf("India")?.[0]).toBe("India");
    expect(countryOf("+91")?.[0]).toBe("India");
    expect(countryOf("IN")?.[0]).toBe("India");
    expect(countryOf("USA")?.[0]).toBe("United States");
    expect(countryOf("Indiana")).toBeUndefined();
  });

  it("picks the phone picker's choice for your country (only a fallback)", () => {
    expect(bestCountryOption(["+93", "+91", "+1"], "India")).toBe(1);
    expect(bestCountryOption(["AF +93", "IN +91"], "India")).toBe(1);
    expect(bestCountryOption(["🇦🇫 Afghanistan (+93)", "🇮🇳 Bharat (+91)"], "India")).toBe(1);
    expect(bestCountryOption(["Indonesia", "Indiana"], "India")).toBeNull();
    // The same words win before any country fallback.
    expect(bestOption(["India (+91)", "+91"], "India")).toBe(0);
    expect(bestOption(["+93", "+91"], "India")).toBe(1);
  });

  it("a picker showing the code counts as your country", () => {
    expect(showsCountry("+91", "India")).toBe(true);
    expect(showsCountry("IN +91", "India")).toBe(true);
    expect(showsCountry("+93", "India")).toBe(false);
    expect(selectionMatches("+91", "India")).toBe(true);
    expect(selectionMatches("Afghanistan", "India")).toBe(false);
  });
});

describe("trace snapshots", () => {
  it("write each component's insides in, with what its fields hold", () => {
    componentPage();
    const input = (document.getElementById("first")?.shadowRoot?.querySelector("input")) as HTMLInputElement;
    input.value = "Testy";
    const { html } = captureDom(1_000_000);
    expect(html).toContain("data-ac-shadow");
    expect(html).toContain('value="Testy"');
    expect(html).toContain("spl-form-element_10");
    expect(document.querySelector("[data-ac-sh]")).toBeNull();
  });
});

describe("what a component's button shows (SmartRecruiters' country code)", () => {
  it("is read through its slots: the flag's name and the code the page puts in it", async () => {
    const { shownValue } = await import("../src/fill/generic-driver");
    document.body.innerHTML = `<spl-phone-field id="phone"><div slot="triggerPrefix"><img alt="India">+<!---->91</div></spl-phone-field>`;
    const root = document.getElementById("phone")?.attachShadow({ mode: "open" });
    if (root)
      root.innerHTML = `<button role="combobox" aria-label="Country code" data-ac-ref="acs6"><div><slot name="triggerPrefix"></slot></div></button>`;
    delete (window as unknown as { __ac?: Locator }).__ac;
    installLocator();
    const shown = shownValue('[data-ac-ref="acs6"]');
    expect(shown).toBe("India +91");
    expect(selectionMatches(shown, "India")).toBe(true);
  });
});

describe("an entry's own Save (a job opened with Edit or Add)", () => {
  const page = (filled: boolean) => {
    document.body.innerHTML = `<header><input type="search" aria-label="Search jobs"></header>
    <form id="apply">
      <input id="fn" value="Testy"><input id="ln" value="User"><input id="em" value="t@example.com">
      <input id="ph"><input id="city">
      <div data-test="experience-edit-form">
        <input id="title" aria-label="Job title" ${filled ? 'value="Lead"' : ""}><input id="company" aria-label="Company">
        <spl-button id="entry-save"></spl-button><button type="button">Cancel</button>
      </div>
      <button type="button" id="main-save">Save</button>
      <button type="submit">Submit application</button>
    </form>`;
    const root = document.getElementById("entry-save")?.attachShadow({ mode: "open" });
    if (root) root.innerHTML = `<button type="button">Save</button>`;
    delete (window as unknown as { __ac?: Locator }).__ac;
    installLocator();
  };
  const box = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) });
  });

  it("is the one clicked: never the page's main Save or Submit", () => {
    page(true);
    const saves = entrySaves();
    expect(saves.map(([, name]) => name)).toEqual(["Save"]);
    const [mark] = saves[0] ?? [];
    const hit = (window as unknown as { __ac: Locator }).__ac.one(mark ?? "");
    expect(hit?.getRootNode()).toBe(document.getElementById("entry-save")?.shadowRoot);
    Element.prototype.getBoundingClientRect = box;
  });

  it("an entry with nothing filled in it isn't saved", () => {
    page(false);
    expect(entrySaves()).toEqual([]);
    Element.prototype.getBoundingClientRect = box;
  });
});
