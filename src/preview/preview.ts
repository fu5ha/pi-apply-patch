import { readFile } from "node:fs/promises";
import type { ApplyPatchPreview, ApplyPatchPreviewFile, ParsedPatch } from "../core_types.js";
import { replaceChunks, resolvePatchPath } from "../patch/patch.js";
import { createPatchDiff } from "./diff.js";
import { formatLineCountSummary, formatPatchFilePath, formatPatchOperation } from "./paths.js";
import { truncatePreview } from "./truncate.js";

async function readExistingFileForPreview(absolutePath: string): Promise<string> {
    try {
        return await readFile(absolutePath, "utf-8");
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}
export function formatPatchPreview(
    preview: ApplyPatchPreview,
    cwd: string = process.cwd(),
    expanded: boolean = true,
): string {
    const lines: string[] = [];
    if (preview.files.length === 1) {
        const file = preview.files[0];
        if (file) {
            lines.push(
                `• ${formatPatchOperation(file.operation)} ${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`,
            );
            if (expanded && file.diff) {
                lines.push(
                    ...truncatePreview(file.diff)
                        .split("\n")
                        .map((line) => `  ${line}`),
                );
            }
        }
        return lines.join("\n");
    }

    const noun = preview.files.length === 1 ? "file" : "files";
    lines.push(`• Edited ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}`);
    for (const file of preview.files) {
        lines.push(`  └ ${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`);
        if (expanded && file.diff) {
            lines.push(
                ...truncatePreview(file.diff)
                    .split("\n")
                    .map((line) => `    ${line}`),
            );
        }
    }
    return lines.join("\n");
}
export async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<ApplyPatchPreview> {
    const files: ApplyPatchPreviewFile[] = [];
    for (const hunk of hunks) {
        const absolutePath = resolvePatchPath(cwd, hunk.filePath);
        if (hunk.type === "add") {
            const oldContent = await readExistingFileForPreview(absolutePath);
            const diff = createPatchDiff(oldContent, hunk.content);
            files.push({
                filePath: hunk.filePath,
                operation: oldContent.length > 0 ? "update" : "add",
                ...diff,
            });
            continue;
        }

        if (hunk.type === "delete") {
            const oldContent = await readFile(absolutePath, "utf-8");
            const diff = createPatchDiff(oldContent, "");
            files.push({ filePath: hunk.filePath, operation: "delete", ...diff });
            continue;
        }

        const oldContent = await readFile(absolutePath, "utf-8");
        const newContent =
            hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks).content;
        if (hunk.movePath) {
            resolvePatchPath(cwd, hunk.movePath);
        }
        const diff = createPatchDiff(oldContent, newContent);
        files.push({
            filePath: hunk.filePath,
            movePath: hunk.movePath,
            operation: "update",
            ...diff,
        });
    }

    return {
        files,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0),
    };
}
