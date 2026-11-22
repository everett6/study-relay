export interface OpenRouterFreeModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  intelligence_index?: number;
}

export interface RankedOpenRouterModel extends OpenRouterFreeModel {
  planner_compatible: boolean;
  supports_tools: boolean;
  supports_json: boolean;
  supports_reasoning: boolean;
}

export function rankOpenRouterFreeModels(models: OpenRouterFreeModel[]): RankedOpenRouterModel[] {
  return models.map((model) => {
    const parameters = new Set(model.supported_parameters ?? []);
    const supports_tools = parameters.has("tools");
    const supports_json = parameters.has("response_format") || parameters.has("structured_outputs");
    return {
      ...model,
      supports_tools,
      supports_json,
      supports_reasoning: parameters.has("reasoning") || parameters.has("include_reasoning"),
      planner_compatible: supports_tools && supports_json,
    };
  }).sort((a, b) =>
    Number(b.planner_compatible) - Number(a.planner_compatible)
    || Number(b.supports_tools) - Number(a.supports_tools)
    || (b.intelligence_index ?? -1) - (a.intelligence_index ?? -1)
    || Number(b.supports_reasoning) - Number(a.supports_reasoning)
    || Number(b.supports_json) - Number(a.supports_json)
    || (b.context_length ?? 0) - (a.context_length ?? 0)
    || (a.name ?? a.id).localeCompare(b.name ?? b.id)
    || a.id.localeCompare(b.id));
}
