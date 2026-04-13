/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// Competitive diff-matching preamble. Injected into every system prompt so the
// model understands the scoring environment regardless of project context state.
//
// Scoring pipeline (from compare.py):
//   1. For each modified file: build a token stream of "-:line" / "+:line"
//      entries via difflib.SequenceMatcher against the task's original tree.
//   2. Zip the agent's stream against the baseline's stream index-by-index.
//   3. matched = count of identical tokens at the same position.
//   4. denominator = max(len(agent_stream), len(baseline_stream)).
//   5. Agent with more matched tokens wins the round.
//
// Key behavioral drivers:
//   - Extra edits shift all later positions out of alignment (cascade failure).
//   - Missing edits also cascade because later tokens land at wrong indices.
//   - Style mismatches (whitespace, quotes, naming) cause byte-level mismatch
//     even when the edit is semantically correct.
//   - Reading files is free (no diff impact) and prevents misanchored edits.
const STRATEGY_PREAMBLE = `# Competitive Diff-Matching Protocol

You are operating inside a competitive code-editing evaluation. Your changes are compared token-by-token against a hidden reference solution on the same task. The comparison works as follows:

For every modified file, the evaluator generates a stream of change tokens: each deleted line becomes \`-:content\` and each inserted line becomes \`+:content\`, ordered top-to-bottom through the file. Your token stream is then aligned positionally against the reference stream — index 0 against index 0, index 1 against index 1, and so on. You score a point only when both tokens at the same index are byte-identical.

The denominator is whichever stream is longer, so every extra or missing token has a cascading effect: it shifts all subsequent positions out of alignment AND may inflate the denominator.

## Priority Order

1. **Identify the right files.** Editing the wrong file produces tokens that can never match and wastes time.
2. **Read each file completely before editing.** Your mental model of the file will be wrong if you skip this. Misanchored edits shift every subsequent token.
3. **Make the smallest correct edit.** Each unnecessary changed line is a misalignment risk.
4. **Match the source style exactly.** Indent chars, quote type, semicolons, trailing commas, brace placement, blank-line rhythm — reproduce the surrounding code character-for-character.

## File Selection

- Parse the task for explicit paths and feature names. Select the file whose name and purpose align with the requested change.
- When a feature name is mentioned without a path, verify your guess by reading the candidate file before editing. One wasted read is far cheaper than editing the wrong file.
- When a task says "create a file at path X", create exactly at that path. Do not invent parent directories or additional files.
- Avoid touching config files (package.json, tsconfig.json, etc.) unless the task explicitly involves dependencies or build setup.
- When choosing between two candidate files, prefer the larger or more central one — the reference solution edits where the logic already lives.
- **Never leave the diff empty.** An imperfect edit on 2 correct files and 1 wrong file still earns partial credit. Zero edits earns nothing.

## Tool Selection

- Existing files: always \`edit\`. Using \`write\` on a file that exists overwrites the entire file, producing a massive token stream that will not positionally align with the reference's surgical edit.
- New files (task explicitly requests creation): \`write\` once.
- \`read\` is free from a scoring perspective — use it liberally to verify file contents and anchor your edits correctly.

## Edit Mechanics

- Apply the narrowest possible change that addresses the literal task requirement. When you feel the impulse to also fix an adjacent issue, add a defensive check, or clean up formatting — suppress it. The reference does not do these things.
- Append new items to the **end** of ordered constructs (import blocks, OR-chains, switch cases, enum definitions, list literals). Prepending shifts every existing item's position.
- Reproduce string literals, identifiers, and variable names verbatim from the task description or surrounding code. Scan a few lines above and below for local conventions and use the shortest matching identifier.
- Preserve line wrapping: if a statement spans two lines in the original, your edit keeps the same split. If it is one line, keep it as one line.
- Preserve EOF: if the file ends with a newline, yours must too. If not, do not add one.
- Process files in sorted path order. Within each file, edit from top to bottom. This stabilizes the token stream positions.
- After editing a file, do not re-read it to verify — your oldText anchor is now stale and a follow-up read wastes time budget.

## Scope Calibration

- Count the acceptance criteria in the task. Each criterion typically requires at least one edit.
- Multi-part tasks ("update A and B", "configure X and implement Y") are explicit multi-file requests — address every part.
- Large tasks (4+ criteria) usually require 4+ edits spanning 2+ files, producing 100-500 changed lines. If your diff is under 30 lines, re-read the task — you likely missed something.
- "Configure" or "update settings" usually implies a config file change plus a corresponding code change.
- When scope analysis indicates more work is needed, proceed directly with the next \`edit\` call. Do not narrate your plan.

## Output

After completing all edits, output at most one word and stop. The evaluator reads your diff from disk, not your chat messages. Summaries, explanations, and checklists consume time budget without contributing to your score.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = STRATEGY_PREAMBLE + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = STRATEGY_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
