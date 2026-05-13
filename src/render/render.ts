import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import type {
    ApplyPatchCallRenderComponent,
    ApplyPatchParams,
    ApplyPatchPreview,
    ApplyPatchPreviewFile,
    ApplyPatchPreviewLike,
    ApplyPatchRenderState,
    ApplyPatchToolDetails,
} from "../core_types.js";
import { PATCH_COLLAPSED_DIFF_LINES } from "../patch/constants.js";
import { extractPatchedPaths, parsePatch } from "../patch/parse.js";
import { formatLineCountSummary, formatPatchFilePath, formatPatchOperation } from "../preview/paths.js";
import { createPatchPreview } from "../preview/preview.js";
import type { ApplyPatchTheme } from "./theme.js";

export function clearApplyPatchRenderState(): void {
    // Renderer state now lives in pi's per-tool-call render context, matching the built-in edit tool.
}

export function formatInFlightCallText(patchText: string): string {
    const paths = extractPatchedPaths(patchText);
    if (paths.length === 0) {
        return "Patching";
    }
    const noun = paths.length === 1 ? "file" : "files";
    const count = paths.length > 1 ? ` (${paths.length} ${noun})` : "";
    return `Patching${count}: ${paths.join(", ")}`;
}

type RenderableAddedDiffLine = {
    content: string;
    kind: "added";
    lineNumber: string;
    sign: "+";
};
type RenderableRemovedDiffLine = {
    content: string;
    kind: "removed";
    lineNumber: string;
    sign: "-";
};

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
    const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
    if (!match) return null;
    return {
        prefix: match[1] ?? "",
        lineNum: match[2] ?? "",
        content: match[3] ?? "",
    };
}

function replaceTabs(text: string): string {
    return text.replace(/\t/g, "   ");
}

function renderInlineDiff(
    oldContent: string,
    newContent: string,
    theme: ApplyPatchTheme,
): { addedLine: string; removedLine: string } {
    const parts = Diff.diffWords(replaceTabs(oldContent), replaceTabs(newContent));
    let addedLine = "";
    let removedLine = "";
    let firstAdded = true;
    let firstRemoved = true;

    for (const part of parts) {
        if (part.added) {
            let value = part.value;
            if (firstAdded) {
                const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
                addedLine += leadingWhitespace;
                value = value.slice(leadingWhitespace.length);
                firstAdded = false;
            }
            if (value) {
                addedLine += theme.inverse(value);
            }
            continue;
        }

        if (part.removed) {
            let value = part.value;
            if (firstRemoved) {
                const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
                removedLine += leadingWhitespace;
                value = value.slice(leadingWhitespace.length);
                firstRemoved = false;
            }
            if (value) {
                removedLine += theme.inverse(value);
            }
            continue;
        }

        addedLine += part.value;
        removedLine += part.value;
    }

    return { addedLine, removedLine };
}

function renderDiff(diffText: string, theme: ApplyPatchTheme): string {
    const lines = diffText.split("\n");
    const rendered: string[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index] ?? "";
        const parsed = parseDiffLine(line);

        if (!parsed) {
            rendered.push(theme.fg("toolDiffContext", line));
            index++;
            continue;
        }

        if (parsed.prefix !== "-") {
            if (parsed.prefix === "+") {
                rendered.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
            } else {
                rendered.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
            }
            index++;
            continue;
        }

        const removedLines: RenderableRemovedDiffLine[] = [];
        while (index < lines.length) {
            const removed = parseDiffLine(lines[index] ?? "");
            if (!removed || removed.prefix !== "-") break;
            removedLines.push({
                content: removed.content,
                kind: "removed",
                lineNumber: removed.lineNum,
                sign: "-",
            });
            index++;
        }

        const addedLines: RenderableAddedDiffLine[] = [];
        while (index < lines.length) {
            const added = parseDiffLine(lines[index] ?? "");
            if (!added || added.prefix !== "+") break;
            addedLines.push({
                content: added.content,
                kind: "added",
                lineNumber: added.lineNum,
                sign: "+",
            });
            index++;
        }

        if (removedLines.length === 1 && addedLines.length === 1) {
            const removedLine = removedLines[0];
            const addedLine = addedLines[0];
            if (removedLine && addedLine) {
                const inline = renderInlineDiff(removedLine.content, addedLine.content, theme);
                rendered.push(theme.fg("toolDiffRemoved", `-${removedLine.lineNumber} ${inline.removedLine}`));
                rendered.push(theme.fg("toolDiffAdded", `+${addedLine.lineNumber} ${inline.addedLine}`));
            }
            continue;
        }

        for (const removedLine of removedLines) {
            rendered.push(
                theme.fg("toolDiffRemoved", `-${removedLine.lineNumber} ${replaceTabs(removedLine.content)}`),
            );
        }
        for (const addedLine of addedLines) {
            rendered.push(theme.fg("toolDiffAdded", `+${addedLine.lineNumber} ${replaceTabs(addedLine.content)}`));
        }
    }

    return rendered.join("\n");
}

function getPreviewDiffLines(diffText: string, expanded: boolean): { lines: string[]; remaining: number } {
    const lines = diffText.split("\n");
    if (expanded || lines.length <= PATCH_COLLAPSED_DIFF_LINES) {
        return { lines, remaining: 0 };
    }

    return {
        lines: lines.slice(0, PATCH_COLLAPSED_DIFF_LINES),
        remaining: lines.length - PATCH_COLLAPSED_DIFF_LINES,
    };
}

function formatToolExpandKeyHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "expand to expand";
    }
}

function formatExpandNote(remaining: number, theme: ApplyPatchTheme): string {
    return `${theme.fg("muted", `... (${remaining} more lines,`)} ${formatToolExpandKeyHint()})`;
}

function renderPatchFilePreview(
    file: ApplyPatchPreviewFile,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
    headerPrefix: string,
): string {
    const summary = `${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`;
    const header =
        headerPrefix.length > 0 ? `${headerPrefix}${summary}` : `• ${formatPatchOperation(file.operation)} ${summary}`;
    if (!file.diff) {
        return header;
    }

    const { lines, remaining } = getPreviewDiffLines(file.diff, expanded);
    const renderedLines = renderDiff(lines.join("\n"), theme).split("\n");
    if (remaining > 0) {
        renderedLines.push(formatExpandNote(remaining, theme));
    }
    const indent = headerPrefix.length > 0 ? "    " : "";
    return `${header}\n${renderedLines.map((line) => `${indent}${line}`).join("\n")}`;
}

function renderPatchPreview(
    preview: ApplyPatchPreview,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
): string {
    if (preview.files.length === 1) {
        const file = preview.files[0];
        return file ? renderPatchFilePreview(file, cwd, theme, expanded, "") : "";
    }

    const noun = preview.files.length === 1 ? "file" : "files";
    const renderedFiles = preview.files
        .map((file) => renderPatchFilePreview(file, cwd, theme, expanded, "  └ "))
        .join("\n");
    if (renderedFiles.length === 0) {
        return "";
    }
    return `• Edited ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}\n${renderedFiles}`;
}

function createApplyPatchCallRenderComponent(): ApplyPatchCallRenderComponent {
    return Object.assign(new Box(1, 1, (text: string) => text), {
        preview: undefined as ApplyPatchPreviewLike | undefined,
        previewArgsKey: undefined as string | undefined,
        previewPending: false,
        settledError: false,
    });
}

export function getApplyPatchCallRenderComponent(
    state: ApplyPatchRenderState | undefined,
    lastComponent: unknown,
): ApplyPatchCallRenderComponent {
    if (lastComponent instanceof Box) {
        const component = lastComponent as ApplyPatchCallRenderComponent;
        if (state) {
            state.callComponent = component;
        }
        return component;
    }
    if (state?.callComponent) {
        return state.callComponent;
    }
    const component = createApplyPatchCallRenderComponent();
    if (state) {
        state.callComponent = component;
    }
    return component;
}

function getApplyPatchHeaderBg(
    preview: ApplyPatchPreviewLike | undefined,
    settledError: boolean | undefined,
    theme: ApplyPatchTheme,
): (text: string) => string {
    if (preview) {
        if ("error" in preview) {
            return (text: string) => theme.bg("toolErrorBg", text);
        }
        return (text: string) => theme.bg("toolSuccessBg", text);
    }
    if (settledError) {
        return (text: string) => theme.bg("toolErrorBg", text);
    }
    return (text: string) => theme.bg("toolPendingBg", text);
}

function formatApplyPatchCall(args: ApplyPatchParams | undefined, theme: ApplyPatchTheme): string {
    const patchText = args?.input ?? "";
    const callText = formatInFlightCallText(patchText);
    const text = callText.length > 0 ? `apply_patch: ${callText}` : "apply_patch";
    return theme.fg("toolTitle", theme.bold(text));
}

export function buildApplyPatchCallComponent(
    component: ApplyPatchCallRenderComponent,
    args: ApplyPatchParams | undefined,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
): ApplyPatchCallRenderComponent {
    component.setBgFn(getApplyPatchHeaderBg(component.preview, component.settledError, theme));
    component.clear();
    component.addChild(new Text(formatApplyPatchCall(args, theme), 0, 0));

    if (!component.preview) {
        return component;
    }

    const body =
        "error" in component.preview
            ? theme.fg("error", component.preview.error)
            : renderPatchPreview(component.preview, cwd, theme, expanded);
    component.addChild(new Spacer(1));
    component.addChild(new Text(body, 0, 0));
    return component;
}

export function setApplyPatchPreview(
    component: ApplyPatchCallRenderComponent,
    preview: ApplyPatchPreviewLike,
    argsKey: string | undefined,
): boolean {
    const current = component.preview;
    const changed =
        current === undefined ||
        ("error" in current && "error" in preview
            ? current.error !== preview.error
            : "error" in current !== "error" in preview) ||
        (!("error" in current) && !("error" in preview) && JSON.stringify(current) !== JSON.stringify(preview));
    component.preview = preview;
    component.previewArgsKey = argsKey;
    component.previewPending = false;
    return changed;
}

export function getApplyPatchArgsKey(args: ApplyPatchParams | undefined): string | undefined {
    if (!args) {
        return undefined;
    }
    return JSON.stringify({ input: args.input });
}

export async function computeApplyPatchPreview(cwd: string, patchText: string): Promise<ApplyPatchPreviewLike> {
    try {
        return await createPatchPreview(cwd, parsePatch(patchText));
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

export function formatApplyPatchResult(
    preview: ApplyPatchPreviewLike | undefined,
    result: AgentToolResult<ApplyPatchToolDetails | undefined>,
    theme: ApplyPatchTheme,
    cwd: string,
    isError: boolean,
    expanded: boolean,
): string | undefined {
    if (isError) {
        const errorText = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .filter((value) => typeof value === "string" && value.length > 0)
            .join("\n");
        const previewError = preview && "error" in preview ? preview.error : undefined;
        if (!errorText || errorText === previewError) {
            return undefined;
        }
        return theme.fg("error", errorText);
    }

    const resultPreview = result.details?.preview;
    if (
        resultPreview &&
        (!preview || "error" in preview || JSON.stringify(resultPreview) !== JSON.stringify(preview))
    ) {
        return renderPatchPreview(resultPreview, cwd, theme, expanded);
    }

    return undefined;
}

export function formatPendingPatchPaths(patchText: string): string {
    const paths = extractPatchedPaths(patchText);
    if (paths.length === 0) {
        return "Applying patch...";
    }
    return `Applying patch...\n${paths.map((filePath) => `• ${filePath}`).join("\n")}`;
}
