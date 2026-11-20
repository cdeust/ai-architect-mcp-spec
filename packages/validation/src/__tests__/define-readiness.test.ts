import { requirementDefinitions } from "../hard-output-rules/rules/requirement-definitions.js";
import { describe, expect, it, vi } from "vitest";
import MarkdownIt from "markdown-it";
import { parseWithoutHtmlQuotes } from "../hard-output-rules/rules/define-html-quotes.js";
import { projectDefineDocument, publicationPoliciesConflict, readPublicationPolicies, validateDefineReadiness, validateDocument } from "../index.js";

const publish = "With `--until ci`, publish the verified commit automatically.";
const stop = "With `--until ci`, stop after CI and never publish the verified commit.";
const requirement = (content: string) => ({ type: "requirements" as const, content });
const overview = (content: string) => ({ type: "overview" as const, content });
const acceptance = (content: string) => ({ type: "acceptance_criteria" as const, content });
const definition = (statement: string) => requirement(`- FR-001: ${statement}`);

describe("Define readiness", () => {
  it("requires numbered definitions in each provided requirements or acceptance section", () => {
    const sections = [requirement("ok"), acceptance("## AC-001\n\n---"), overview("ok")];
    const findings = validateDefineReadiness(sections);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "missing_prd_definitions",
        sectionType: "requirements",
        isCritical: true,
        message: "The requirements section must define at least one FR or NFR statement.",
      }),
      expect.objectContaining({
        rule: "missing_prd_definitions",
        sectionType: "acceptance_criteria",
        isCritical: true,
        message: "The acceptance_criteria section must define at least one AC statement.",
      }),
    ]);
    const report = validateDocument(sections);
    expect(report.hasCriticalViolations).toBe(true);
    expect(report.rulesPassed).not.toContain("missing_prd_definitions");
    expect(report.totalScore).toBeLessThan(1);
  });

  it("accepts a concise numbered definition and partial requests without those sections", () => {
    expect(validateDefineReadiness([
      requirement("- NFR-001: Encrypt files."),
      acceptance("- AC-001: Files are encrypted."),
    ])).toEqual([]);
    expect(validateDefineReadiness([overview("Encrypt saved files.")])).toEqual([]);
    expect(validateDefineReadiness([])).toEqual([]);
  });

  it("reports both sources of an explicit policy conflict once, in document order", () => {
    const first = overview(publish);
    const second = definition(stop);
    const third = definition("With `--until ci`, never publish the verified commit.");
    expect(validateDefineReadiness([first, second, third])).toEqual([
      expect.objectContaining({
        rule: "contradictory_publication_policy",
        isCritical: true,
        message: `Conflicting publication instructions for --until ci: overview says "${publish}"; requirements/FR-001 says "${stop}".`,
      }),
    ]);
    expect(validateDefineReadiness([second, first])).toEqual([
      expect.objectContaining({ message: expect.stringContaining(`requirements/FR-001 says "${stop}"; overview says`) }),
    ]);
  });

  it.each([
    ["different flag value", stop.replace("--until ci", "--until test")],
    ["different flag", stop.replace("--until ci", "--dry-run")],
    ["different condition", stop.replace("With", "Without")],
    ["different target", stop.replace("the verified commit", "the verification report")],
    ["different operation", stop.replace("publish", "archive")],
    ["same decision", publish],
  ])("keeps %s distinct", (_reason, statement) => {
    expect(validateDefineReadiness([overview(publish), definition(statement)])).toEqual([]);
  });

  it("ignores code examples and requires a conflict across sections", () => {
    expect(validateDefineReadiness([overview(`\`\`\`md\n${publish}\n\`\`\``), definition(stop)])).toEqual([]);
    expect(validateDefineReadiness([overview(`## ${publish}`), definition(stop)])).toEqual([]);
    expect(validateDefineReadiness([overview(`${publish}\n\n${stop}`), overview("Other scope.")])).toEqual([]);
    const manual = publish.replace(" automatically", "");
    expect(validateDefineReadiness([overview(`${manual}\n\n${stop}`)])).toEqual([]);
    expect(validateDefineReadiness([overview(`${publish}\n\n${stop.replace("commit.", "commit automatically.")}`)])).toEqual([]);
  });

  it("reports later cross-section conflicts even when the earlier section contains both polarities", () => {
    expect(validateDefineReadiness([overview(`${publish}\n\n${stop}`), definition(stop)])).toEqual([
      expect.objectContaining({ rule: "contradictory_publication_policy" }),
    ]);
  });

  it.each([
    `- **FR-001:** ${stop}`,
    `| ID | Requirement |\n| --- | --- |\n| FR-001 | ${stop} |`,
  ])("reads the conflict from supported Markdown requirement definitions", content => {
    expect(validateDefineReadiness([overview(publish), requirement(content)])).toEqual([
      expect.objectContaining({ message: expect.stringContaining("requirements/FR-001") }),
    ]);
  });

  it("distinguishes manual publication, automatic publication and case-sensitive targets", () => {
    const ban = definition(stop.replace("commit.", "commit automatically."));
    const manual = overview(publish.replace(" automatically", ""));
    expect(validateDefineReadiness([manual, ban])).toEqual([]);
    expect(validateDefineReadiness([ban, manual])).toEqual([]);
    for (const sections of [[overview(publish), ban], [ban, overview(publish)], [definition(stop), manual]]) {
      expect(validateDefineReadiness(sections)).toEqual([
        expect.objectContaining({ rule: "contradictory_publication_policy" }),
      ]);
    }
    expect(validateDefineReadiness([
      overview(publish.replace("verified commit", "tag Release")),
      definition(stop.replace("verified commit", "tag release")),
    ])).toEqual([]);
  });

  it("keeps the first source and reports independent flag scopes", () => {
    const sections = [
      requirement(`- FR-007: ${publish}\n- FR-008: ${publish}\n- FR-009: ${publish.replace("--until ci", "--dry-run")}`),
      overview(`${stop}\n\n${stop.replace("--until ci", "--dry-run").replace("stop after CI and never", "never")}`),
    ];
    expect(validateDefineReadiness(sections)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('requirements/FR-007 says') }),
      expect.objectContaining({ message: expect.stringContaining('requirements/FR-009 says') }),
    ]);
    const longValue = "publication-preview";
    expect(validateDefineReadiness([
      overview(publish.replace("--until ci", `--until ${longValue}`)),
      definition(stop.replace("--until ci", `--until ${longValue}`)),
    ])).toHaveLength(1);
  });

  it("does not find a directive embedded in an example or erase meaningful target text", () => {
    expect(validateDefineReadiness([overview(`Example: ${publish}`), definition(stop)])).toEqual([]);
    expect(validateDefineReadiness([overview(publish.replace("publish", "documents how to publish")), definition(stop)])).toEqual([]);
    expect(validateDefineReadiness([overview(publish), definition(stop.replace("stop after CI and never", "documents when not to"))])).toEqual([]);
    expect(validateDefineReadiness([overview(`${publish}\u2028Additional prose.`), definition(stop)])).toEqual([]);
    expect(validateDefineReadiness([
      overview(publish.replace("verified commit", "tag v1.2")),
      definition(stop.replace("verified commit", "tag v12")),
    ])).toEqual([]);
    expect(validateDefineReadiness([
      overview(publish.replace("verified commit automatically", "automatically named tag")),
      definition(stop.replace("verified commit", "named tag")),
    ])).toEqual([]);
  });

  it("supports continued paragraphs and definitions with explicit indentation", () => {
    const prose = overview(`Delivery policy:\n   ${publish}  \nDetails follow.`);
    const requirements = requirement(`- FR-011: Delivery rule.\n     ${stop}  \n  Stop this command.`);
    expect(validateDefineReadiness([prose, requirements])).toEqual([
      expect.objectContaining({ message: expect.stringContaining('requirements/FR-011 says') }),
    ]);
  });

  it("keeps punctuation inside an explicitly opposed publication target", () => {
    const dotted = publish.replace("verified commit", "tag v1.2");
    const dottedBan = stop.replace("verified commit", "tag v1.2");
    expect(validateDefineReadiness([overview(dotted), definition(dottedBan)])).toHaveLength(1);
    const colon = publish.replace("verified commit", "tag vault:stable");
    const colonBan = stop.replace("verified commit", "tag vault:stable");
    const table = requirement(`| ID | Requirement |\n| --- | --- |\n| FR-010 | ${colon} |`);
    expect(validateDefineReadiness([table, overview(colonBan)])).toHaveLength(1);
  });

  it.each([" ", "\t", ",\t", ",   "])("reads a conditional directive with separator %j", separator => {
    const directive = publish.replace("`, ", "`" + separator);
    expect(validateDefineReadiness([overview(directive), definition(stop)])).toHaveLength(1);
  });
});

it("reads the normative policy and Source cell from a traced requirement table", () => {
  for (const header of ["Source", "Traceability", "Source/Traceability"]) {
    const table = `| ID | Requirement | Priority | ${header} |\n| --- | --- | --- | --- |\n| FR-001 | ${stop} | P1 | clarification:3:3 |`;
    const [found] = [...readPublicationPolicies(table, "requirements")];
    expect(found).toMatchObject({ label: "requirements/FR-001", source: "clarification:3:3", statement: stop });
    expect(projectDefineDocument([requirement(table)]).requirements).toEqual([{ id: "FR-001", text: stop }]);
  }
  const firstRow = `| FR-001 | ${stop} |\n| --- | --- |`;
  expect([...readPublicationPolicies(firstRow, "requirements")][0]).toMatchObject({ statement: stop });
});

it("compares traced acceptance statements and leaves a non-acceptance target untouched", () => {
  const traced = publish.replace(/\.$/, " (FR-001, NFR-002).");
  const [ac] = [...readPublicationPolicies(`- AC-001: ${traced}`, "acceptance_criteria")];
  expect(ac).toMatchObject({ label: "acceptance_criteria/AC-001", statement: traced, policy: { automatic: true, target: "the verified commit" } });
  const [fr] = [...readPublicationPolicies(`- FR-001: ${traced}`, "requirements")];
  expect(fr?.policy).toMatchObject({ automatic: false, target: "the verified commit automatically (FR-001, NFR-002)" });
  const [policy] = [...readPublicationPolicies(stop)];
  expect(policy?.label).toBe("overview");
  expect(publicationPoliciesConflict(ac!.policy, policy!.policy)).toBe(true);
  expect(publicationPoliciesConflict(policy!.policy, ac!.policy)).toBe(true);
  expect(publicationPoliciesConflict(ac!.policy, ac!.policy)).toBe(false);
  expect(publicationPoliciesConflict(fr!.policy, policy!.policy)).toBe(false);
});

it("keeps Markdown and wrapped HTML quotes out of normative statements and projection", () => {
  const content = [
    '<div><BLOCKQUOTE cite="source">',
    '',
    'An inline code example: `</blockquote>`.',
    '',
    '<blockquote>',
    `- FR-002: ${publish}`,
    '</blockquote>',
    '',
    `- FR-003: ${publish}`,
    '</BLOCKQUOTE>',
    '</div>',
    '',
    `> ${publish}\n>\n> > - FR-004: ${publish}`,
    '',
    `- FR-001: ${stop}`,
  ].join("\n");
  expect([...readPublicationPolicies(content, "requirements")]).toEqual([
    expect.objectContaining({ label: "requirements/FR-001", statement: stop }),
  ]);
  expect(projectDefineDocument([requirement(content)]).requirements).toEqual([{ id: "FR-001", text: stop }]);
  expect([...readPublicationPolicies(`> ${publish}\n\n${stop}`)]).toEqual([expect.objectContaining({ statement: stop })]);
});

it("preserves the first definition row and the exact legacy shape of a table without a source", () => {
  const firstRow = "| FR-001 | Source |\n| --- | --- |";
  expect(requirementDefinitions(firstRow, undefined, { readSource: true })).toStrictEqual([{ id: "FR-001", text: "Source" }]);
  const unlabeled = `| ID | Requirement |\n| --- | --- |\n| FR-001 | ${stop} |`;
  expect(requirementDefinitions(unlabeled, undefined, { readSource: true })).toStrictEqual([{ id: "FR-001", text: stop }]);
});

it("retains normative text outside inline quotes and masks unclosed and nested quoted content", () => {
  const text = `<div><blockquote>\r\nOld example: <blockquote-example> and \`</blockquote>\`.\r\n</blockquote></div>\r\n${stop}`;
  const policy = (value: string) => [...readPublicationPolicies(value)].map(({ statement }) => statement);
  expect(policy(text)).toEqual([stop]);
  expect(policy(`${stop}\n<blockquote>\n\n${publish}`)).toEqual([stop]);
  expect(policy(`</blockquote>\n> <blockquote>\n\n${stop}`)).toEqual([stop]);
  expect(policy(`Text\n<!--\n<blockquote>\n-->\n\n${stop}`)).toEqual([stop]);
  expect(policy(`${stop}\n<!--\n<blockquote>\n${publish}`)).toEqual([stop]);
  expect(policy(`> <blockquote>\n\n<div><blockquote>\n${publish}\n</blockquote></div>\n${stop}`)).toEqual([stop]);
  expect(policy(`<div data-example="<blockquote>">\n${stop}\n</div>`)).toEqual([stop]);

  const inline = "- FR-001: Retain the signed receipt. <blockquote>Legacy rule.<blockquote>Nested legacy rule.</blockquote>More legacy text.</blockquote>";
  const additional = "- FR-002: Retain the plan.";
  expect(projectDefineDocument([requirement(`${inline}\n${additional}`)]).requirements).toEqual([
    { id: "FR-001", text: "Retain the signed receipt." },
    { id: "FR-002", text: "Retain the plan." },
  ]);
  const table = "| ID | Requirement | Source |\n| --- | --- | --- |\n| FR-001 | Retain the signed receipt. <blockquote>Legacy rule.</blockquote> | user-request |\n| FR-002 | <blockquote>Legacy requirement.</blockquote> | Prior design |";
  expect(projectDefineDocument([requirement(table)]).requirements).toEqual([
    { id: "FR-001", text: "Retain the signed receipt." },
    { id: "FR-002", text: "" },
  ]);
});

it("uses the plain inline-free parser for ordinary sections", () => {
  const parser = new MarkdownIt("commonmark").disable("inline");
  const parse = vi.spyOn(parser, "parse");
  expect(parseWithoutHtmlQuotes(stop, parser)).toContainEqual(expect.objectContaining({ type: "inline", content: stop, children: [] }));
  expect(parse).toHaveBeenCalledWith(stop, {});
});
