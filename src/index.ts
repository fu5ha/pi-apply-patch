import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ApplyPatchExtensionAPI } from "./core_types.js";
import { GPT_APPLY_PATCH_PROVIDERS, STANDARD_EDIT_TOOL_NAMES } from "./patch/constants.js";
import { createApplyPatchTool } from "./tool.js";

export default function registerApplyPatchExtension(pi: ApplyPatchExtensionAPI): void {
    pi.registerTool(createApplyPatchTool());

    pi.on("session_start", async (_event, ctx) => {
        syncToolset(pi, ctx.model);
    });

    pi.on("model_select", async (event) => {
        syncToolset(pi, event.model);
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        syncToolset(pi, ctx.model);
    });
}

function isOpenAIGptModel(model: Pick<Model<string>, "provider" | "id"> | undefined): boolean {
    return model !== undefined && GPT_APPLY_PATCH_PROVIDERS.has(model.provider) && model.id.startsWith("gpt-");
}

function withoutExtensionManagedEditTools(toolNames: string[]): string[] {
    return toolNames.filter(
        (toolName) =>
            toolName !== "apply_patch" && !STANDARD_EDIT_TOOL_NAMES.some((editToolName) => editToolName === toolName),
    );
}

function replaceEditToolsWithApplyPatch(toolNames: string[]): string[] {
    return [...withoutExtensionManagedEditTools(toolNames), "apply_patch"];
}

function replaceApplyPatchWithEditTools(toolNames: string[]): string[] {
    return [...withoutExtensionManagedEditTools(toolNames), ...STANDARD_EDIT_TOOL_NAMES];
}

function syncToolset(
    pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
    model: Model<string> | undefined,
): void {
    const currentToolNames = pi.getActiveTools();
    if (isOpenAIGptModel(model)) {
        pi.setActiveTools(replaceEditToolsWithApplyPatch(currentToolNames));
        return;
    }

    pi.setActiveTools(replaceApplyPatchWithEditTools(currentToolNames));
}
