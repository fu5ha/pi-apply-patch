import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Box } from "@earendil-works/pi-tui";
import type { APPLY_PATCH_PARAMS } from "./patch/constants.js";

export type ParsedPatch =
    | { type: "add"; filePath: string; content: string }
    | { type: "delete"; filePath: string }
    | {
          type: "update";
          filePath: string;
          movePath?: string;
          chunks: PatchChunk[];
      };

export type PatchChunk = {
    changeContexts: string[];
    oldLines: string[];
    newLines: string[];
    isEndOfFile: boolean;
};

export type FreeformToolFormat = {
    type: "grammar";
    syntax: "lark";
    definition: string;
};

export type ApplyPatchParams = { input: string };
export type ApplyPatchOperation = "add" | "delete" | "update";

export type ApplyPatchPreviewFile = {
    filePath: string;
    movePath?: string;
    operation: ApplyPatchOperation;
    content?: string;
    diff: string;
    added: number;
    removed: number;
};
export type ApplyPatchPreview = {
    files: ApplyPatchPreviewFile[];
    added: number;
    removed: number;
};

export type ApplyPatchProgress = {
    applied: number;
    failed: number;
    total: number;
};
export type ApplyPatchProgressCallback = (progress: ApplyPatchProgress) => Promise<void> | void;

export type ApplyPatchFailure = {
    filePath: string;
    operation: ApplyPatchOperation;
    message: string;
};

export type ApplyPatchRecoveryInstructions = {
    mustReadFiles: string[];
    mustNotReadFiles: string[];
};

export type ApplyPatchResult = {
    summaries: string[];
    appliedFiles: string[];
    failures: ApplyPatchFailure[];
    hasPartialSuccess: boolean;
    recoveryInstructions: ApplyPatchRecoveryInstructions;
    details: { fuzz: number };
};

export type ApplyPatchToolDetails = {
    preview?: ApplyPatchPreview;
    progress?: ApplyPatchProgress;
    result?: ApplyPatchResult;
};

export type ApplyPatchRenderState = {
    callComponent?: ApplyPatchCallRenderComponent;
};

export type ApplyPatchPreviewLike = ApplyPatchPreview | { error: string };

export type ApplyPatchCallRenderComponent = Box & {
    headerComponent?: Box;
    bodyComponent?: Box;
    preview?: ApplyPatchPreviewLike;
    previewArgsKey?: string;
    previewPending?: boolean;
    settledError?: boolean;
    streamingAddFileCaches?: Record<string, ApplyPatchStreamingAddFileHighlightCache | undefined>;
};

export type ApplyPatchStreamingAddFileHighlightCache = {
    rawPath: string;
    lang: string;
    rawContent: string;
    normalizedLines: string[];
    highlightedLines: string[];
};

export type ApplyPatchToolDefinition = ToolDefinition<typeof APPLY_PATCH_PARAMS, ApplyPatchToolDetails | undefined> & {
    freeform: FreeformToolFormat;
};

export type ApplyPatchToolDefinitionWithState = ToolDefinition<
    typeof APPLY_PATCH_PARAMS,
    ApplyPatchToolDetails | undefined,
    ApplyPatchRenderState
> & { freeform: FreeformToolFormat };

export type ApplyPatchExtensionAPI = Pick<ExtensionAPI, "on" | "getActiveTools" | "setActiveTools"> & {
    registerTool: (tool: ApplyPatchToolDefinition) => void;
};

export type ApplyPatchToolResult = AgentToolResult<ApplyPatchToolDetails | undefined>;

export class ApplyPatchError extends Error {
    public readonly failures: ApplyPatchFailure[];
    public readonly result: ApplyPatchResult;
    constructor(message: string, result: ApplyPatchResult) {
        super(message);
        this.name = "ApplyPatchError";
        this.failures = result.failures;
        this.result = result;
    }
    hasPartialSuccess(): boolean {
        return this.result.hasPartialSuccess;
    }
}
