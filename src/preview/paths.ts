import path from "node:path";
import type { ApplyPatchOperation, ApplyPatchPreviewFile } from "../core_types.js";

export function formatLineCountSummary(added: number, removed: number): string {
    return `(+${added} -${removed})`;
}

function normalizeDisplayPath(filePath: string): string {
    return filePath.replaceAll(path.sep, "/");
}

export function displayPath(filePath: string, cwd: string): string {
    if (!path.isAbsolute(filePath)) {
        return normalizeDisplayPath(filePath);
    }

    const absoluteCwd = path.resolve(cwd);
    const relativePath = path.relative(absoluteCwd, filePath);
    if (
        relativePath === "" ||
        (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
    ) {
        return normalizeDisplayPath(relativePath || ".");
    }

    return normalizeDisplayPath(filePath);
}

export function formatPatchFilePath(file: ApplyPatchPreviewFile, cwd: string = process.cwd()): string {
    const filePath = displayPath(file.filePath, cwd);
    if (!file.movePath) {
        return filePath;
    }
    return `${filePath} → ${displayPath(file.movePath, cwd)}`;
}

export function formatPatchOperation(operation: ApplyPatchOperation): string {
    if (operation === "add") {
        return "Added";
    }
    if (operation === "delete") {
        return "Deleted";
    }
    return "Edited";
}
