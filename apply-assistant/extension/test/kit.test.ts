// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { focusedField, pickFrame, resumeUpload } from "../src/kit/page-fill";
import { resumePath, safeName } from "../src/kit/resume-file";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusedField", () => {
  it("describes the focused field by its label, and types into it", () => {
    document.body.innerHTML = `
      <label for="e">Work email</label><input id="e" name="email" type="email" autocomplete="email">`;
    const input = document.getElementById("e") as HTMLInputElement;
    input.value = "old";
    input.focus();
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push(input.value));

    expect(focusedField(null)).toEqual({
      field: {
        tag: "input",
        type: "email",
        name: "email",
        id: "e",
        label: "Work email",
        autocomplete: "email",
      },
    });
    const done = focusedField("me@example.com");
    expect(done?.shown).toBe("me@example.com");
    expect(input.value).toBe("me@example.com");
    expect(seen).toContain("me@example.com");
  });

  it("ignores fields it must not type into", () => {
    document.body.innerHTML = `<input id="p" type="password"><input id="c" type="checkbox"><input id="r" readonly>`;
    for (const id of ["p", "c", "r"]) {
      (document.getElementById(id) as HTMLInputElement).focus();
      expect(focusedField("x")).toBeNull();
    }
    (document.activeElement as HTMLElement | null)?.blur();
    expect(focusedField("x")).toBeNull();
  });

  it("falls back to aria-label and placeholder", () => {
    document.body.innerHTML = `<textarea aria-label="Why us?"></textarea><input placeholder="City">`;
    (document.querySelector("textarea") as HTMLTextAreaElement).focus();
    expect(focusedField(null)?.field.label).toBe("Why us?");
    (document.querySelector("input") as HTMLInputElement).focus();
    expect(focusedField(null)?.field.label).toBe("City");
  });
});

describe("resumeUpload", () => {
  it("picks the resume field over the cover letter and attaches the PDF", () => {
    document.body.innerHTML = `
      <label>Cover letter <input type="file" name="cover_letter"></label>
      <label>Resume/CV <input type="file" name="resume" accept=".pdf,.docx"></label>`;
    const changes: string[] = [];
    const resume = document.querySelector(
      'input[name="resume"]',
    ) as HTMLInputElement;
    resume.addEventListener("change", () => changes.push("change"));

    expect(resumeUpload(null)).toMatchObject({
      field: { name: "resume", label: "Resume/CV" },
      score: 4,
    });
    // jsdom has no DataTransfer; the real browser path is covered by the side-panel e2e.
    if (typeof DataTransfer === "undefined") return;
    resumeUpload({ base64: btoa("%PDF-1.5"), name: "A_B_Resume.pdf" });
    expect(resume.files?.[0]?.name).toBe("A_B_Resume.pdf");
    expect(changes).toEqual(["change"]);
  });

  it("finds nothing on a page without uploads", () => {
    document.body.innerHTML = "<input name='x'>";
    expect(resumeUpload(null)).toBeNull();
  });
});

describe("pickFrame", () => {
  it("takes the best score, the top frame winning ties", () => {
    expect(
      pickFrame(
        [
          { frameId: 0, result: { score: 1 } },
          { frameId: 7, result: { score: 4 } },
          { frameId: 9, result: null },
        ],
        (r) => r.score,
      ),
    ).toBe(7);
    expect(
      pickFrame(
        [
          { frameId: 3, result: { score: 0 } },
          { frameId: 0, result: { score: 0 } },
        ],
        (r) => r.score,
      ),
    ).toBe(0);
    expect(pickFrame([{ frameId: 0, result: null }], () => 0)).toBeNull();
  });
});

describe("resume file names", () => {
  it("makes names every OS accepts", () => {
    expect(safeName('Acme: "Platform" / Infra?\u0007')).toBe(
      "Acme Platform Infra",
    );
    expect(safeName("...")).toBe("Job");
    expect(
      resumePath(
        { employer: "Acme Inc.", title: "Senior Engineer (Backend)" },
        "Test_C_Resume.pdf",
      ),
    ).toBe("JobOps/Acme Inc. - Senior Engineer (Backend)/Test_C_Resume.pdf");
  });
});
