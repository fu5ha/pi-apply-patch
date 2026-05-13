import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getLanguageFromPath, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import type {
    ApplyPatchCallRenderComponent,
    ApplyPatchParams,
    ApplyPatchPreview,
    ApplyPatchPreviewFile,
    ApplyPatchPreviewLike,
    ApplyPatchRenderState,
    ApplyPatchStreamingAddFileHighlightCache,
    ApplyPatchToolDetails,
} from "../core_types.js";
import { PATCH_COLLAPSED_DIFF_LINES } from "../patch/constants.js";
import { extractPatchedPaths, parsePatch } from "../patch/parse.js";
import { formatLineCountSummary, formatPatchFilePath } from "../preview/paths.js";
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

function normalizeDisplayText(text: string): string {
    return text.replace(/\r/g, "");
}

type StreamingAddFileSection = {
    path: string;
    content: string;
    index: number;
};

export function extractAddFileSections(patchText: string): StreamingAddFileSection[] {
    const sections: Array<{ path: string; lines: string[]; index: number }> = [];
    let active: { path: string; lines: string[]; index: number } | undefined;
    for (const line of patchText.split("\n")) {
        const addFileMatch = line.match(/^\*\*\* Add File:\s*(.*)$/);
        if (addFileMatch) {
            active = { path: addFileMatch[1] ?? "", lines: [], index: sections.length };
            sections.push(active);
            continue;
        }

        if (line.startsWith("*** ")) {
            active = undefined;
            continue;
        }

        if (!active || !line.startsWith("+")) {
            continue;
        }

        active.lines.push(line.slice(1));
    }

    return sections.map((section) => ({
        path: section.path,
        content: section.lines.join("\n"),
        index: section.index,
    }));
}

export function extractActiveAddFileSection(patchText: string): StreamingAddFileSection | undefined {
    let active: StreamingAddFileSection | undefined;
    let addIndex = 0;
    for (const line of patchText.split("\n")) {
        const addFileMatch = line.match(/^\*\*\* Add File:\s*(.*)$/);
        if (addFileMatch) {
            active = { path: addFileMatch[1] ?? "", content: "", index: addIndex };
            addIndex++;
            continue;
        }
        if (line.startsWith("*** ")) {
            active = undefined;
            continue;
        }
        if (!active || !line.startsWith("+")) {
            continue;
        }
        active = {
            ...active,
            content: active.content ? `${active.content}\n${line.slice(1)}` : line.slice(1),
        };
    }
    return active;
}

const STREAMING_ADD_FILE_FULL_HIGHLIGHT_LINES = 50;

function highlightStreamingLine(line: string, lang: string): string {
    try {
        return highlightCode(line, lang)[0] ?? "";
    } catch {
        return line;
    }
}

function refreshStreamingHighlightPrefix(cache: ApplyPatchStreamingAddFileHighlightCache): void {
    const prefixCount = Math.min(STREAMING_ADD_FILE_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
    if (prefixCount === 0) return;
    const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
    let prefixHighlighted: string[];
    try {
        prefixHighlighted = highlightCode(prefixSource, cache.lang);
    } catch {
        prefixHighlighted = prefixSource.split("\n");
    }
    for (let i = 0; i < prefixCount; i++) {
        cache.highlightedLines[i] =
            prefixHighlighted[i] ?? highlightStreamingLine(cache.normalizedLines[i] ?? "", cache.lang);
    }
}

function rebuildStreamingHighlightCacheFull(
    rawPath: string,
    fileContent: string,
): ApplyPatchStreamingAddFileHighlightCache | undefined {
    const lang = getLanguageFromPath(rawPath);
    if (!lang) return undefined;
    const normalized = replaceTabs(normalizeDisplayText(fileContent));
    let highlightedLines: string[];
    try {
        highlightedLines = highlightCode(normalized, lang);
    } catch {
        highlightedLines = normalized.split("\n");
    }
    return {
        rawPath,
        lang,
        rawContent: fileContent,
        normalizedLines: normalized.split("\n"),
        highlightedLines,
    };
}

function updateStreamingHighlightCacheIncremental(
    cache: ApplyPatchStreamingAddFileHighlightCache | undefined,
    rawPath: string,
    fileContent: string,
): ApplyPatchStreamingAddFileHighlightCache | undefined {
    const lang = getLanguageFromPath(rawPath);
    if (!lang) return undefined;
    if (!cache) return rebuildStreamingHighlightCacheFull(rawPath, fileContent);
    if (cache.lang !== lang || cache.rawPath !== rawPath)
        return rebuildStreamingHighlightCacheFull(rawPath, fileContent);
    if (!fileContent.startsWith(cache.rawContent)) return rebuildStreamingHighlightCacheFull(rawPath, fileContent);
    if (fileContent.length === cache.rawContent.length) return cache;

    const deltaNormalized = replaceTabs(normalizeDisplayText(fileContent.slice(cache.rawContent.length)));
    cache.rawContent = fileContent;
    if (cache.normalizedLines.length === 0) {
        cache.normalizedLines.push("");
        cache.highlightedLines.push("");
    }

    const segments = deltaNormalized.split("\n");
    const lastIndex = cache.normalizedLines.length - 1;
    cache.normalizedLines[lastIndex] += segments[0] ?? "";
    cache.highlightedLines[lastIndex] = highlightStreamingLine(cache.normalizedLines[lastIndex] ?? "", cache.lang);
    for (let i = 1; i < segments.length; i++) {
        const segment = segments[i] ?? "";
        cache.normalizedLines.push(segment);
        cache.highlightedLines.push(highlightStreamingLine(segment, cache.lang));
    }
    refreshStreamingHighlightPrefix(cache);
    return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") {
        end--;
    }
    return lines.slice(0, end);
}

function formatStreamingAddFileBody(
    section: StreamingAddFileSection,
    cache: ApplyPatchStreamingAddFileHighlightCache | undefined,
    theme: ApplyPatchTheme,
    expanded: boolean,
): string | undefined {
    if (!section.content) {
        return undefined;
    }
    const lang = getLanguageFromPath(section.path);
    const renderedLines = lang
        ? (cache?.highlightedLines ?? replaceTabs(normalizeDisplayText(section.content)).split("\n"))
        : normalizeDisplayText(section.content)
              .split("\n")
              .map((line) => theme.fg("toolOutput", replaceTabs(line)));
    const lines = trimTrailingEmptyLines(renderedLines);
    const totalLines = lines.length;
    const maxLines = expanded ? totalLines : 10;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    let text = displayLines.join("\n");
    if (remaining > 0) {
        text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${formatToolExpandKeyHint()})`;
    }
    return text;
}

function countRenderableLines(content: string): number {
    return trimTrailingEmptyLines(normalizeDisplayText(content).split("\n")).length;
}

function addSectionCacheKey(section: StreamingAddFileSection): string {
    return `${section.index}:${section.path}`;
}

function getAddSectionCache(
    component: ApplyPatchCallRenderComponent,
    section: StreamingAddFileSection,
): ApplyPatchStreamingAddFileHighlightCache | undefined {
    return component.streamingAddFileCaches?.[addSectionCacheKey(section)];
}

function setAddSectionCache(
    component: ApplyPatchCallRenderComponent,
    section: StreamingAddFileSection,
    cache: ApplyPatchStreamingAddFileHighlightCache | undefined,
): void {
    component.streamingAddFileCaches ??= {};
    component.streamingAddFileCaches[addSectionCacheKey(section)] = cache;
    component.streamingAddFileCache = cache;
}

function clearAddSectionCaches(component: ApplyPatchCallRenderComponent): void {
    component.streamingAddFileCache = undefined;
    component.streamingAddFileCaches = undefined;
}

function renderAddFileSection(
    component: ApplyPatchCallRenderComponent,
    section: StreamingAddFileSection,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
    file?: ApplyPatchPreviewFile,
    headerPrefix = "",
): string | undefined {
    const cache = updateStreamingHighlightCacheIncremental(
        getAddSectionCache(component, section),
        section.path,
        section.content,
    );
    setAddSectionCache(component, section, cache);
    const body = formatStreamingAddFileBody(section, cache, theme, expanded);
    if (!body) {
        return undefined;
    }
    const previewFile =
        file ??
        ({
            filePath: section.path,
            operation: "add",
            diff: "",
            added: countRenderableLines(section.content),
            removed: 0,
        } satisfies ApplyPatchPreviewFile);
    const summary = `${formatColoredPatchFilePath(previewFile, cwd, theme)} ${formatColoredLineCountSummary(previewFile.added, previewFile.removed, theme)}`;
    const header =
        headerPrefix.length > 0 ? `${headerPrefix}${summary}` : `◆ ${theme.fg("toolDiffAdded", "add")} ${summary}`;
    const indent = headerPrefix.length > 0 ? "    " : "";
    return `${header}\n${body
        .split("\n")
        .map((line) => `${indent}${line}`)
        .join("\n")}`;
}

function renderProvisionalAddFileSections(
    component: ApplyPatchCallRenderComponent,
    args: ApplyPatchParams | undefined,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
    argsComplete: boolean,
): string | undefined {
    const sections = argsComplete
        ? getSingleOrMultipleAddFileSections(args)
        : extractAddFileSections(args?.input ?? "");
    const rendered = sections
        .map((section) => renderAddFileSection(component, section, cwd, theme, expanded))
        .filter((section): section is string => typeof section === "string" && section.length > 0);
    return rendered.length > 0 ? rendered.join("\n\n") : undefined;
}

function renderMixedPatchPreview(
    component: ApplyPatchCallRenderComponent,
    args: ApplyPatchParams | undefined,
    preview: ApplyPatchPreview,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
): string {
    const addSectionsByIndex = new Map<number, StreamingAddFileSection>();
    for (const section of getSingleOrMultipleAddFileSections(args)) {
        addSectionsByIndex.set(section.index, section);
    }

    const renderedFiles = preview.files.map((file, index) => {
        const addSection = addSectionsByIndex.get(index);
        if (file.operation === "add" && addSection) {
            return renderAddFileSection(component, addSection, cwd, theme, expanded, file, "");
        }
        return renderPatchFilePreview(file, cwd, theme, expanded, "");
    });

    if (preview.files.length === 1) {
        return renderedFiles[0] ?? "";
    }

    return renderedFiles.filter((file): file is string => typeof file === "string" && file.length > 0).join("\n\n");
}

function getSingleOrMultipleAddFileSections(args: ApplyPatchParams | undefined): StreamingAddFileSection[] {
    if (!args?.input) {
        return [];
    }

    try {
        const hunks = parsePatch(args.input);
        return hunks.flatMap((hunk, index) =>
            hunk.type === "add" ? [{ path: hunk.filePath, content: hunk.content, index }] : [],
        );
    } catch {
        return [];
    }
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

function formatColoredLineCountSummary(added: number, removed: number, theme: ApplyPatchTheme): string {
    return `(${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)})`;
}

function formatColoredPatchOperation(operation: ApplyPatchPreviewFile["operation"], theme: ApplyPatchTheme): string {
    if (operation === "add") {
        return theme.fg("toolDiffAdded", "add");
    }
    if (operation === "delete") {
        return theme.fg("toolDiffRemoved", "delete");
    }
    return theme.fg("toolTitle", "edit");
}

function formatColoredPatchFilePath(file: ApplyPatchPreviewFile, cwd: string, theme: ApplyPatchTheme): string {
    return theme.fg("accent", formatPatchFilePath(file, cwd));
}

function renderPatchFilePreview(
    file: ApplyPatchPreviewFile,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
    headerPrefix: string,
): string {
    const summary = `${formatColoredPatchFilePath(file, cwd, theme)} ${formatColoredLineCountSummary(file.added, file.removed, theme)}`;
    const header =
        headerPrefix.length > 0
            ? `${headerPrefix}${summary}`
            : `◆ ${formatColoredPatchOperation(file.operation, theme)} ${summary}`;
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
        .join("\n\n");
    if (renderedFiles.length === 0) {
        return "";
    }
    return `◆ edit ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}\n${renderedFiles}`;
}

function createApplyPatchCallRenderComponent(): ApplyPatchCallRenderComponent {
    return Object.assign(new Box(0, 0), {
        headerComponent: undefined as Box | undefined,
        bodyComponent: undefined as Box | undefined,
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

function getApplyPatchBodyBg(
    preview: ApplyPatchPreviewLike | undefined,
    settledError: boolean | undefined,
    theme: ApplyPatchTheme,
): (text: string) => string {
    if ((preview && "error" in preview) || settledError) {
        return (text: string) => theme.bg("toolErrorBg", text);
    }
    return (text: string) => theme.bg("toolPendingBg", text);
}

function formatApplyPatchCall(args: ApplyPatchParams | undefined, theme: ApplyPatchTheme): string {
    const patchText = args?.input ?? "";
    const paths = extractPatchedPaths(patchText);
    const title = theme.fg("toolTitle", theme.bold("apply_patch"));
    if (paths.length === 0) {
        return title;
    }
    return `${title} (${paths.map((filePath) => theme.fg("accent", filePath)).join(", ")})`;
}

export function buildApplyPatchCallComponent(
    component: ApplyPatchCallRenderComponent,
    args: ApplyPatchParams | undefined,
    cwd: string,
    theme: ApplyPatchTheme,
    expanded: boolean,
    argsComplete: boolean,
): ApplyPatchCallRenderComponent {
    component.clear();
    component.setBgFn(undefined);

    const headerComponent = component.headerComponent ?? new Box(1, 1);
    component.headerComponent = headerComponent;
    headerComponent.setBgFn(getApplyPatchHeaderBg(component.preview, component.settledError, theme));
    headerComponent.clear();
    headerComponent.addChild(new Text(formatApplyPatchCall(args, theme), 0, 0));
    component.addChild(headerComponent);

    const addBody = (body: string): void => {
        const bodyComponent = component.bodyComponent ?? new Box(1, 1);
        component.bodyComponent = bodyComponent;
        bodyComponent.setBgFn(getApplyPatchBodyBg(component.preview, component.settledError, theme));
        bodyComponent.clear();
        bodyComponent.addChild(new Text(body, 0, 0));
        component.addChild(bodyComponent);
    };

    if (!component.preview) {
        const body = renderProvisionalAddFileSections(component, args, cwd, theme, expanded, argsComplete);
        if (!body) {
            clearAddSectionCaches(component);
            return component;
        }
        addBody(body);
        return component;
    }

    const body =
        "error" in component.preview
            ? theme.fg("error", component.preview.error)
            : renderMixedPatchPreview(component, args, component.preview, cwd, theme, expanded);
    addBody(body);
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
