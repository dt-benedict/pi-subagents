export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

interface RegistryModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Minimal structural view of pi's model registry. Kept structural so callers can
 * pass the ExtensionContext registry without importing its concrete type.
 */
export interface LiveModelRegistry<M> {
	refresh?: () => void;
	getAvailable: () => M[];
}

/**
 * Return the currently available models, refreshing the registry from disk first.
 *
 * pi core only reloads models.json on certain actions (e.g. opening `/model`), so
 * a long-running session otherwise holds a snapshot captured at startup. Without
 * this refresh, models added or edited in models.json mid-session never appear in
 * subagent model pickers or validation, and look like a frozen/"hard coded" list.
 *
 * Refresh failures fall back to the last-known snapshot instead of throwing, so a
 * transient models.json write can never break model resolution or execution.
 */
export function getLiveAvailableModels<M>(modelRegistry: LiveModelRegistry<M>): M[] {
	try {
		modelRegistry.refresh?.();
	} catch {
		// Ignore refresh errors and use the last successfully loaded snapshot.
	}
	return modelRegistry.getAvailable();
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
	return {
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
	if (!suffix) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: `:${suffix}`,
	};
}

export function findModelInfo(model: string | undefined, availableModels: ModelInfo[] | undefined, preferredProvider?: string): ModelInfo | undefined {
	if (!model || !availableModels || availableModels.length === 0) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(model);
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact;

	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferred = matches.find((entry) => entry.provider === preferredProvider);
		if (preferred) return preferred;
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model) return [...THINKING_LEVELS];
	if (model.reasoning === false) return ["off"];

	if (!model.thinkingLevelMap) return [...THINKING_LEVELS];

	const levels = THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
	return levels;
}
