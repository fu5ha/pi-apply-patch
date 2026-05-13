import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
    ApplyPatchFailure,
    ApplyPatchProgress,
    ApplyPatchProgressCallback,
    ApplyPatchResult,
    ParsedPatch,
} from "../core_types.js";
import { ApplyPatchError } from "../core_types.js";
import { createRecoveryInstructions, writeFileAtomic } from "../file_ops.js";
import { normalizePatchText, parsePatch } from "./parse.js";
import { replaceChunks, resolvePatchPath } from "./patch.js";

async function notifyApplyPatchProgress(
    onProgress: ApplyPatchProgressCallback | undefined,
    progress: ApplyPatchProgress,
): Promise<void> {
    try {
        await onProgress?.(progress);
    } catch {
        // Rendering progress must not affect patch application or recovery details.
    }
}
export async function applySingleHunk(
    cwd: string,
    hunk: ParsedPatch,
): Promise<{ summary: string; appliedFile: string; fuzz: number }> {
    const absolutePath = resolvePatchPath(cwd, hunk.filePath);
    if (hunk.type === "add") {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFileAtomic(absolutePath, hunk.content);
        return {
            summary: `add: ${hunk.filePath}`,
            appliedFile: hunk.filePath,
            fuzz: 0,
        };
    }

    if (hunk.type === "delete") {
        await stat(absolutePath);
        await rm(absolutePath);
        return {
            summary: `delete: ${hunk.filePath}`,
            appliedFile: hunk.filePath,
            fuzz: 0,
        };
    }

    const currentContent = await readFile(absolutePath, "utf-8");
    const chunkResult =
        hunk.chunks.length === 0
            ? { content: currentContent, fuzz: 0 }
            : replaceChunks(currentContent, hunk.filePath, hunk.chunks);
    const nextContent = chunkResult.content;

    if (hunk.movePath) {
        const absoluteMovePath = resolvePatchPath(cwd, hunk.movePath);
        await mkdir(path.dirname(absoluteMovePath), { recursive: true });
        await writeFileAtomic(absoluteMovePath, nextContent);
        if (absoluteMovePath !== absolutePath) {
            await rm(absolutePath);
        }
        return {
            summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
            appliedFile: hunk.movePath,
            fuzz: chunkResult.fuzz,
        };
    }

    await writeFileAtomic(absolutePath, nextContent);
    return {
        summary: `update: ${hunk.filePath}`,
        appliedFile: hunk.filePath,
        fuzz: chunkResult.fuzz,
    };
}

export async function applyPatchDetailed(
    cwd: string,
    patchText: string,
    onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
    const hunks = parsePatch(patchText);
    if (hunks.length === 0) {
        const normalized = normalizePatchText(patchText).trim();
        if (normalized === "*** Begin Patch\n*** End Patch") {
            throw new Error("patch rejected: empty patch");
        }
        throw new Error("apply_patch verification failed: no hunks found");
    }

    const summaries: string[] = [];
    const appliedFiles: string[] = [];
    const failures: ApplyPatchFailure[] = [];
    let fuzz = 0;

    for (const hunk of hunks) {
        try {
            const { summary, appliedFile, fuzz: hunkFuzz } = await applySingleHunk(cwd, hunk);
            summaries.push(summary);
            appliedFiles.push(appliedFile);
            fuzz += hunkFuzz;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ filePath: hunk.filePath, operation: hunk.type, message });
        }
        await notifyApplyPatchProgress(onProgress, {
            applied: appliedFiles.length,
            failed: failures.length,
            total: hunks.length,
        });
    }

    const result: ApplyPatchResult = {
        summaries,
        appliedFiles,
        failures,
        hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
        recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [] },
        details: { fuzz },
    };
    result.recoveryInstructions = createRecoveryInstructions(result);
    return result;
}
export async function applyPatch(cwd: string, patchText: string): Promise<string[]> {
    const hunks = parsePatch(patchText);
    if (hunks.length === 0) {
        const normalized = normalizePatchText(patchText).trim();
        if (normalized === "*** Begin Patch\n*** End Patch") {
            throw new Error("patch rejected: empty patch");
        }
        throw new Error("apply_patch verification failed: no hunks found");
    }

    const summaries: string[] = [];
    const appliedFiles: string[] = [];
    for (const hunk of hunks) {
        try {
            const { summary, appliedFile } = await applySingleHunk(cwd, hunk);
            summaries.push(summary);
            appliedFiles.push(appliedFile);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result: ApplyPatchResult = {
                summaries,
                appliedFiles,
                failures: [{ filePath: hunk.filePath, operation: hunk.type, message }],
                hasPartialSuccess: appliedFiles.length > 0,
                recoveryInstructions: createRecoveryInstructions({
                    appliedFiles,
                    failures: [{ filePath: hunk.filePath, operation: hunk.type, message }],
                }),
                details: { fuzz: 0 },
            };
            throw new ApplyPatchError(message, result);
        }
    }

    return summaries;
}
