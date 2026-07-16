import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildBuiltinOverrideConfig,
	discoverAgentsAll,
	frontmatterNameForConfig,
	removeBuiltinAgentOverride,
	saveBuiltinAgentOverride,
	type AgentConfig,
	type BuiltinAgentOverrideBase,
} from "../agents/agents.ts";
import { serializeAgent } from "../agents/agent-serializer.ts";
import { findModelInfo, getLiveAvailableModels, getSupportedThinkingLevels, toModelInfo } from "../shared/model-info.ts";

const ADMIN_MESSAGE_TYPE = "subagents-admin";
const INHERIT_MODEL_CHOICE = "Default / inherit session model";
const INHERIT_THINKING_CHOICE = "Default / inherit session thinking";

type ModelInfo = { provider: string; id: string };

function sourceRank(source: AgentConfig["source"]): number {
	if (source === "project") return 0;
	if (source === "user") return 1;
	if (source === "package") return 2;
	return 3;
}

function allVisibleAgents(cwd: string): AgentConfig[] {
	const d = discoverAgentsAll(cwd);
	return [...d.project, ...d.user, ...d.package, ...d.builtin]
		.filter((agent) => !agent.disabled)
		.sort((a, b) => a.name.localeCompare(b.name) || sourceRank(a.source) - sourceRank(b.source));
}

function agentLabel(agent: AgentConfig): string {
	const model = agent.model ? ` · ${agent.model}` : "";
	return `${agent.name} [${agent.source}]${model} — ${agent.description}`;
}

function agentMatches(agent: AgentConfig, rawName: string): boolean {
	const name = rawName.trim();
	return agent.name === name || frontmatterNameForConfig(agent) === name;
}

function sendAdminMessage(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({
		customType: ADMIN_MESSAGE_TYPE,
		content,
		display: true,
	});
}

function modelFullId(model: ModelInfo): string {
	return `${model.provider}/${model.id}`;
}

function buildBuiltinBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
		subagentOnlyExtensions: agent.subagentOnlyExtensions ? [...agent.subagentOnlyExtensions] : undefined,
		completionGuard: agent.completionGuard,
		toolBudget: agent.toolBudget,
	};
}

type EditableOverrideField = "model" | "thinking" | "systemPrompt";

function savesThroughSettings(agent: AgentConfig, field: EditableOverrideField): boolean {
	if (agent.source === "builtin" || agent.source === "package") return true;
	if (!agent.override) return false;
	// A lower-scope override can flow into a higher-scope custom agent with the
	// same name. Persist that agent's edits in its own frontmatter instead of
	// rewriting the shared lower-scope override used by another agent.
	if (agent.source !== agent.override.scope) return false;
	// Custom-agent overrides fill only fields absent from frontmatter. Compare the
	// effective value with the pre-override base so an override on one field does
	// not redirect edits to an unrelated frontmatter-owned field.
	return agent[field] !== agent.override.base[field];
}

async function selectAgent(ctx: ExtensionContext, args: string): Promise<AgentConfig | undefined> {
	const agents = allVisibleAgents(ctx.cwd);
	if (agents.length === 0) return undefined;

	const requestedName = args.trim().split(/\s+/)[0] ?? "";
	if (requestedName) {
		const matches = agents.filter((agent) => agentMatches(agent, requestedName));
		if (matches.length === 1 || !ctx.hasUI) return matches[0];
		if (matches.length > 1) {
			const byLabel = new Map(matches.map((agent) => [agentLabel(agent), agent] as const));
			const choice = await ctx.ui.select(`Multiple subagents named '${requestedName}'`, [...byLabel.keys()]);
			return choice ? byLabel.get(choice) : undefined;
		}
		return undefined;
	}

	if (!ctx.hasUI) return undefined;
	const byLabel = new Map(agents.map((agent) => [agentLabel(agent), agent] as const));
	const choice = await ctx.ui.select("Select subagent", [...byLabel.keys()]);
	return choice ? byLabel.get(choice) : undefined;
}

function metadataFor(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)];
	const lines = [
		`Agent: ${agent.name} (${agent.source})`,
		`Path: ${agent.filePath}`,
		`Description: ${agent.description}`,
	];
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	lines.push(`Model: ${agent.model ?? "default / inherit"}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.override) lines.push(`Override: ${agent.override.scope} (${agent.override.path})`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

async function chooseModel(ctx: ExtensionContext, agent: AgentConfig): Promise<string | undefined | null> {
	const models = getLiveAvailableModels(ctx.modelRegistry).map((model) => modelFullId(model));
	const current = agent.model ?? INHERIT_MODEL_CHOICE;
	const choices = [INHERIT_MODEL_CHOICE, ...models.filter((model) => model !== agent.model)];
	if (agent.model && !choices.includes(agent.model)) choices.splice(1, 0, agent.model);
	const choice = await ctx.ui.select(`Select model for ${agent.name}\nCurrent: ${current}`, choices);
	if (!choice) return null;
	return choice === INHERIT_MODEL_CHOICE ? undefined : choice;
}

async function chooseThinking(ctx: ExtensionContext, agent: AgentConfig): Promise<string | undefined | null> {
	// Filter the offered levels to what the agent's configured model actually supports
	// (e.g. a non-reasoning model only offers "off"). Falls back to all levels when the
	// model is inherited or cannot be uniquely resolved.
	const availableModels = getLiveAvailableModels(ctx.modelRegistry).map(toModelInfo);
	const modelInfo = findModelInfo(agent.model, availableModels, ctx.model?.provider);
	const levels = getSupportedThinkingLevels(modelInfo);
	const current = agent.thinking ?? INHERIT_THINKING_CHOICE;
	const choices: string[] = [INHERIT_THINKING_CHOICE, ...levels];
	// Keep the current value selectable even if the model no longer advertises it.
	if (agent.thinking && !choices.includes(agent.thinking)) choices.splice(1, 0, agent.thinking);
	const modelNote = agent.model ? `Model: ${agent.model}` : "Model: default / inherit";
	const choice = await ctx.ui.select(
		`Select thinking level for ${agent.name}\n${modelNote} · Current: ${current}`,
		choices,
	);
	if (!choice) return null;
	return choice === INHERIT_THINKING_CHOICE ? undefined : choice;
}

async function chooseBuiltinOverrideScope(ctx: ExtensionContext, agent: AgentConfig): Promise<"user" | "project" | undefined> {
	if (agent.override?.scope) return agent.override.scope;
	const d = discoverAgentsAll(ctx.cwd);
	if (!d.projectSettingsPath || !ctx.hasUI) return "user";
	const choice = await ctx.ui.select(`Save builtin override for ${agent.name}`, ["user", "project"]);
	return choice === "user" || choice === "project" ? choice : undefined;
}

async function saveAgentModel(ctx: ExtensionContext, agent: AgentConfig, selectedModel: string | undefined): Promise<string> {
	if (savesThroughSettings(agent, "model")) {
		const scope = await chooseBuiltinOverrideScope(ctx, agent);
		if (!scope) return "Cancelled.";
		const base = agent.override?.base ?? buildBuiltinBase(agent);
		const draft: AgentConfig = { ...agent, model: selectedModel };
		const override = buildBuiltinOverrideConfig(base, draft);
		const filePath = override
			? saveBuiltinAgentOverride(ctx.cwd, agent.name, scope, override)
			: removeBuiltinAgentOverride(ctx.cwd, agent.name, scope).path;
		return selectedModel
			? `Saved ${scope} settings override for '${agent.name}' with model '${selectedModel}' in ${filePath}.`
			: `Cleared model settings override for '${agent.name}' in ${filePath}.`;
	}

	const updated: AgentConfig = { ...agent, model: selectedModel };
	fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
	return selectedModel
		? `Updated '${agent.name}' model to '${selectedModel}' in ${updated.filePath}.`
		: `Cleared '${agent.name}' model in ${updated.filePath}.`;
}

async function saveAgentThinking(ctx: ExtensionContext, agent: AgentConfig, selectedThinking: string | undefined): Promise<string> {
	if (savesThroughSettings(agent, "thinking")) {
		const scope = await chooseBuiltinOverrideScope(ctx, agent);
		if (!scope) return "Cancelled.";
		const base = agent.override?.base ?? buildBuiltinBase(agent);
		const draft: AgentConfig = { ...agent, thinking: selectedThinking };
		const override = buildBuiltinOverrideConfig(base, draft);
		const filePath = override
			? saveBuiltinAgentOverride(ctx.cwd, agent.name, scope, override)
			: removeBuiltinAgentOverride(ctx.cwd, agent.name, scope).path;
		return selectedThinking
			? `Saved ${scope} settings override for '${agent.name}' with thinking '${selectedThinking}' in ${filePath}.`
			: `Cleared thinking settings override for '${agent.name}' in ${filePath}.`;
	}

	const updated: AgentConfig = { ...agent, thinking: selectedThinking };
	fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
	return selectedThinking
		? `Updated '${agent.name}' thinking to '${selectedThinking}' in ${updated.filePath}.`
		: `Cleared '${agent.name}' thinking in ${updated.filePath}.`;
}

/** Compact one-line summary shown in the interactive picker (no full system prompt dump). */
function metadataSummary(agent: AgentConfig): string {
	return [
		`Source: ${agent.source}`,
		`Model: ${agent.model ?? "default / inherit"}`,
		`Thinking: ${agent.thinking ?? "default / inherit"}`,
	].join(" · ");
}

interface EditorSpec {
	command: string;
	args: string[];
	raw: string;
}

/**
 * Resolve the external editor command. Uses $VISUAL/$EDITOR (expected to block, e.g.
 * `open -W -n -a MarkEdit`), falling back to MarkEdit on macOS. Terminal editors that
 * need an attached TTY are not supported here since pi owns the terminal.
 */
function resolveEditorCommand(): EditorSpec | undefined {
	const raw = (process.env.VISUAL || process.env.EDITOR || "").trim()
		|| (process.platform === "darwin" ? "open -W -n -a MarkEdit" : "");
	if (!raw) return undefined;
	const parts = raw.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return undefined;
	return { command: parts[0]!, args: parts.slice(1), raw };
}

function editorLabel(editor: EditorSpec): string {
	const appIdx = editor.args.indexOf("-a");
	if (editor.command === "open" && appIdx !== -1 && editor.args[appIdx + 1]) return editor.args[appIdx + 1]!;
	return editor.command;
}

function runEditorAndWait(editor: EditorSpec, filePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(editor.command, [...editor.args, filePath], { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", () => resolve());
	});
}

async function saveAgentSystemPrompt(ctx: ExtensionContext, agent: AgentConfig, systemPrompt: string): Promise<string> {
	const nextPrompt = systemPrompt.replace(/\s+$/, "");
	if (savesThroughSettings(agent, "systemPrompt")) {
		const scope = await chooseBuiltinOverrideScope(ctx, agent);
		if (!scope) return "Cancelled.";
		const base = agent.override?.base ?? buildBuiltinBase(agent);
		const draft: AgentConfig = { ...agent, systemPrompt: nextPrompt };
		const override = buildBuiltinOverrideConfig(base, draft);
		const filePath = override
			? saveBuiltinAgentOverride(ctx.cwd, agent.name, scope, override)
			: removeBuiltinAgentOverride(ctx.cwd, agent.name, scope).path;
		return `Saved ${scope} settings override for '${agent.name}' system prompt in ${filePath}.`;
	}
	const updated: AgentConfig = { ...agent, systemPrompt: nextPrompt };
	fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
	return `Updated '${agent.name}' system prompt in ${updated.filePath}.`;
}

/**
 * Round-trip the agent's system prompt through the user's external editor: write it to a
 * temp .md file, open the editor and wait for it to close, then persist the result.
 * Returns the status message, or null when nothing should be posted.
 */
async function editSystemPrompt(ctx: ExtensionContext, agent: AgentConfig): Promise<string | null> {
	const editor = resolveEditorCommand();
	if (!editor) {
		return "No editor configured. Set $VISUAL or $EDITOR (e.g. 'open -W -n -a MarkEdit').";
	}
	const label = editorLabel(editor);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-prompt-"));
	const safeName = path.basename(agent.name.replace(/[^a-z0-9._-]/gi, "_")) || "agent";
	const tmpPath = path.join(dir, `${safeName}.md`);
	try {
		fs.writeFileSync(tmpPath, agent.systemPrompt ?? "", "utf-8");
		ctx.ui.notify(`Editing '${agent.name}' system prompt in ${label}. Save and close the editor window to apply.`, "info");
		ctx.ui.setStatus("subagents-edit", `Waiting for ${label} to close…`);
		await runEditorAndWait(editor, tmpPath);
		const edited = fs.readFileSync(tmpPath, "utf-8");
		if (edited.replace(/\s+$/, "") === (agent.systemPrompt ?? "").replace(/\s+$/, "")) {
			return `System prompt for '${agent.name}' left unchanged.`;
		}
		return await saveAgentSystemPrompt(ctx, agent, edited);
	} finally {
		ctx.ui.setStatus("subagents-edit", undefined);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
	}
}

export async function openSubagentsAdmin(pi: ExtensionAPI, ctx: ExtensionContext, args = ""): Promise<void> {
	const agent = await selectAgent(ctx, args);
	if (!agent) {
		const agents = allVisibleAgents(ctx.cwd);
		const requestedName = args.trim().split(/\s+/)[0];
		const text = requestedName
			? `Subagent '${requestedName}' not found.\n\nAvailable subagents:\n${agents.map((a) => `- ${a.name} (${a.source})`).join("\n") || "- (none)"}`
			: `Available subagents:\n${agents.map((a) => `- ${a.name} (${a.source})`).join("\n") || "- (none)"}`;
		sendAdminMessage(pi, text);
		return;
	}

	if (!ctx.hasUI) {
		// Non-interactive (tool/headless): emit full metadata as the inspection result.
		sendAdminMessage(pi, metadataFor(agent));
		return;
	}

	const requestedAction = args.trim().split(/\s+/)[1]?.toLowerCase();
	let action: string | undefined;
	if (requestedAction === "model") action = "Change model";
	else if (requestedAction === "thinking") action = "Change thinking level";
	else if (requestedAction === "prompt" || requestedAction === "system-prompt" || requestedAction === "edit") action = "Edit system prompt";
	else if (requestedAction === "details" || requestedAction === "info") action = "Show details";
	if (!action) {
		action = await ctx.ui.select(
			`Administer ${agent.name}\n${metadataSummary(agent)}`,
			["Change model", "Change thinking level", "Edit system prompt", "Show details", "Done"],
		);
	}

	try {
		if (action === "Change model") {
			const selectedModel = await chooseModel(ctx, agent);
			if (selectedModel === null) return;
			const message = await saveAgentModel(ctx, agent, selectedModel);
			ctx.ui.notify(message, "info");
			sendAdminMessage(pi, message);
		} else if (action === "Change thinking level") {
			const selectedThinking = await chooseThinking(ctx, agent);
			if (selectedThinking === null) return;
			const message = await saveAgentThinking(ctx, agent, selectedThinking);
			ctx.ui.notify(message, "info");
			sendAdminMessage(pi, message);
		} else if (action === "Edit system prompt") {
			const message = await editSystemPrompt(ctx, agent);
			if (message === null) return;
			ctx.ui.notify(message, "info");
			sendAdminMessage(pi, message);
		} else if (action === "Show details") {
			// Full metadata is now opt-in (previously always posted to the thread).
			sendAdminMessage(pi, metadataFor(agent));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(message, "error");
		sendAdminMessage(pi, `Failed to update '${agent.name}': ${message}`);
	}
}
