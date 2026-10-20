// Real Claude call on the saved Greenhouse forms with the FAKE resume (no personal data):
// checks the request shape is accepted and the answers are sensible. Costs a fraction of a cent.
//   ANTHROPIC_API_KEY=... npx tsx spike/claude-questions.ts
import Anthropic from "@anthropic-ai/sdk";
import { createClaudeAnswerer } from "../server/src/claude/answerer.js";
import { isAnswerable, toQuestion } from "../server/src/claude/questions.js";
import { classifyField } from "../server/src/plan/classify.js";
import { parseGreenhouseSchema } from "../server/src/plan/gh-schema.js";
import { resumeFacts } from "../server/src/plan/resume-facts.js";
import { createClaudeAnswersRepo } from "../server/src/store/claude-answers-repo.js";
import { openStore } from "../server/src/store/db.js";
import { fakeDesignResume } from "../server/test/fixtures/fake-resume.js";
import newrelic from "../server/test/fixtures/gh-newrelic.json" with {
  type: "json",
};

const answerer = createClaudeAnswerer({
  messages: new Anthropic().messages,
  cache: createClaudeAnswersRepo(openStore(":memory:")),
  mapModel: "claude-haiku-5-5",
  draftModel: "claude-sonnet-5-5",
  log: (line) => console.log(line),
});

const schema = parseGreenhouseSchema(newrelic);
const questions = [
  ...schema.fields
    .filter((f) => isAnswerable(f) && classifyField(f).rule.kind === "question")
    .map(toQuestion),
  // Invented ones to exercise "bank", "write" and an unknowable answer.
  {
    ref: "x_relocate",
    label: "Would you be open to moving to Hyderabad for this role?",
    type: "select" as const,
    options: ["Yes", "No"],
  },
  {
    ref: "x_why",
    label: "Why do you want to work at New Relic?",
    type: "textarea" as const,
    options: [],
  },
  {
    ref: "x_ts",
    label: "How many years of TypeScript experience do you have?",
    type: "text" as const,
    options: [],
  },
];

const answers = await answerer.answer(questions, {
  job: {
    title: "Senior Software Engineer",
    employer: "New Relic",
    description: "Build observability APIs in TypeScript and Go.",
  },
  resume: resumeFacts(fakeDesignResume),
  bank: new Map([
    ["work.relocation", "Yes"],
    ["location.current_city", "Bengaluru"],
  ]),
});
for (const q of questions)
  console.log(
    `\n${q.label.slice(0, 90)}\n  →`,
    JSON.stringify(answers.get(q.ref)),
  );
