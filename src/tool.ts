import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type {
    ApplyPatchParams,
    ApplyPatchPreview,
    ApplyPatchProgress,
    ApplyPatchRenderState,
    ApplyPatchToolDefinitionWithState,
    ApplyPatchToolDetails,
    FreeformToolFormat,
} from "./core_types.js";
import { applyPatchDetailed } from "./patch/apply.js";
import { APPLY_PATCH_FREEFORM_DESCRIPTION, APPLY_PATCH_LARK_GRAMMAR, APPLY_PATCH_PARAMS } from "./patch/constants.js";
import { parsePatch } from "./patch/parse.js";
import { createPatchPreview, formatPatchPreview } from "./preview/preview.js";
import {
    buildApplyPatchCallComponent,
    computeApplyPatchPreview,
    formatApplyPatchResult,
    formatPendingPatchPaths,
    getApplyPatchArgsKey,
    getApplyPatchCallRenderComponent,
    setApplyPatchPreview,
} from "./render/render.js";

export function normalizeApplyPatchArguments(args: unknown): ApplyPatchParams {
    if (typeof args === "string") {
        return { input: args };
    }

    if (args && typeof args === "object" && "input" in args) {
        const input = (args as { input?: unknown }).input;
        if (typeof input === "string") {
            return { input };
        }
    }

    return { input: "" };
}

async function createPendingPatchUpdate(
    cwd: string,
    patchText: string,
    progress?: ApplyPatchProgress,
    previewOverride?: ApplyPatchPreview,
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
    const title = progress
        ? `Applying patch (${progress.applied + progress.failed}/${progress.total})...`
        : "Applying patch...";
    if (previewOverride) {
        return {
            text: `${title}\n${formatPatchPreview(previewOverride)}`,
            details: { preview: previewOverride, progress },
        };
    }

    try {
        const hunks = parsePatch(patchText);
        if (hunks.length === 0) {
            return { text: title, details: progress ? { progress } : undefined };
        }

        const preview = await createPatchPreview(cwd, hunks);
        if (preview.files.some((file) => file.diff.trim().length > 0)) {
            return {
                text: `${title}\n${formatPatchPreview(preview)}`,
                details: { preview, progress },
            };
        }
    } catch {
        return {
            text: progress ? title : formatPendingPatchPaths(patchText),
            details: progress ? { progress } : undefined,
        };
    }

    return {
        text: progress ? title : formatPendingPatchPaths(patchText),
        details: progress ? { progress } : undefined,
    };
}

export function createApplyPatchTool(): ApplyPatchToolDefinitionWithState {
    const tool = defineTool({
        name: "apply_patch",
        label: "ApplyPatch",
        description: APPLY_PATCH_FREEFORM_DESCRIPTION,
        parameters: APPLY_PATCH_PARAMS,
        renderShell: "self",
        prepareArguments: normalizeApplyPatchArguments,
        promptSnippet: "Apply Codex-format file patches with apply_patch",
        promptGuidelines: [
            "Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
            "After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
        ],
        async execute(
            _toolCallId,
            params,
            _signal,
            onUpdate,
            ctx,
        ): Promise<AgentToolResult<ApplyPatchToolDetails | undefined>> {
            const normalizedParams = normalizeApplyPatchArguments(params);
            if (!normalizedParams.input) {
                throw new Error("input is required");
            }

            let totalOperations = 0;
            try {
                totalOperations = parsePatch(normalizedParams.input).length;
            } catch {
                // createPendingPatchUpdate keeps incomplete or invalid patch text renderable.
            }
            const initialProgress = totalOperations > 0 ? { applied: 0, failed: 0, total: totalOperations } : undefined;
            const pendingUpdate = await createPendingPatchUpdate(ctx.cwd, normalizedParams.input, initialProgress);
            onUpdate?.({
                content: [{ type: "text", text: pendingUpdate.text }],
                details: pendingUpdate.details,
            });

            const preview = pendingUpdate.details?.preview;
            const result = await applyPatchDetailed(ctx.cwd, normalizedParams.input, async (progress) => {
                const progressUpdate = await createPendingPatchUpdate(
                    ctx.cwd,
                    normalizedParams.input,
                    progress,
                    preview,
                );
                onUpdate?.({
                    content: [{ type: "text", text: progressUpdate.text }],
                    details: progressUpdate.details,
                });
            });
            if (result.failures.length > 0) {
                const failed = result.recoveryInstructions.mustReadFiles.join(", ");
                const mustReadText = failed.includes(",") ? failed.split(", ").join(" and ") : failed;
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                "apply_patch partially failed.",
                                `Failed: ${failed}`,
                                `Recovery: MUST read ${mustReadText} before retrying.`,
                                result.appliedFiles.length > 0
                                    ? "Earlier file actions in this patch were already applied."
                                    : "No file actions were applied.",
                                result.recoveryInstructions.mustNotReadFiles.length > 0
                                    ? "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it."
                                    : "",
                            ]
                                .filter((line) => line.length > 0)
                                .join("\n"),
                        },
                    ],
                    details: preview ? { preview, result } : { result },
                };
            }

            return {
                content: [{ type: "text", text: result.summaries.join("\n") }],
                details: preview ? { preview, result } : { result },
            };
        },
        renderCall(args, theme, context) {
            const component = getApplyPatchCallRenderComponent(context.state, context.lastComponent);
            const normalizedArgs = normalizeApplyPatchArguments(args);
            const argsKey = getApplyPatchArgsKey(normalizedArgs);

            if (component.previewArgsKey !== argsKey) {
                component.preview = undefined;
                component.previewArgsKey = argsKey;
                component.previewPending = false;
                component.settledError = false;
            }

            if (context.argsComplete && normalizedArgs.input && !component.preview && !component.previewPending) {
                component.previewPending = true;
                const requestKey = argsKey;
                void computeApplyPatchPreview(context.cwd, normalizedArgs.input).then((preview) => {
                    if (component.previewArgsKey === requestKey) {
                        setApplyPatchPreview(component, preview, requestKey);
                        context.invalidate?.();
                    }
                });
            }

            return buildApplyPatchCallComponent(
                component,
                normalizedArgs,
                context.cwd,
                theme,
                context.expanded,
                context.argsComplete,
            );
        },
        renderResult(result, _options, theme, context) {
            const callComponent = context.state?.callComponent;
            const normalizedArgs = normalizeApplyPatchArguments(context.args);
            const argsKey = getApplyPatchArgsKey(normalizedArgs);
            let changed = false;
            if (callComponent) {
                const preview = result.details?.preview;
                if (preview) {
                    changed = setApplyPatchPreview(callComponent, preview, argsKey) || changed;
                }
                if (result.details?.progress && callComponent.preview) {
                    changed = true;
                }
                if (callComponent.settledError !== context.isError) {
                    callComponent.settledError = context.isError;
                    changed = true;
                }
                if (changed) {
                    buildApplyPatchCallComponent(
                        callComponent,
                        normalizedArgs,
                        context.cwd,
                        theme,
                        context.expanded,
                        true,
                    );
                }
            }

            const output = formatApplyPatchResult(
                callComponent?.preview,
                result,
                theme,
                context.cwd,
                context.isError,
                _options.expanded,
            );
            const component = (context.lastComponent as Container | undefined) ?? new Container();
            component.clear();
            if (!output) {
                return component;
            }
            component.addChild(new Spacer(1));
            component.addChild(new Text(output, 1, 0));
            return component;
        },
    } satisfies ToolDefinition<typeof APPLY_PATCH_PARAMS, ApplyPatchToolDetails | undefined, ApplyPatchRenderState>);

    return Object.assign(tool, {
        freeform: {
            type: "grammar",
            syntax: "lark",
            definition: APPLY_PATCH_LARK_GRAMMAR,
        } satisfies FreeformToolFormat,
    });
}
