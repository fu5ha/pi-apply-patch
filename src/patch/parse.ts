import type { ParsedPatch, PatchChunk } from "../core_types.js";

export function normalizePatchText(patchText: string): string {
    return patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripHeredoc(input: string): string {
    const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
    if (heredocMatch) {
        return heredocMatch[2] ?? input;
    }
    return input;
}

export function extractPatchedPaths(patchText: string): string[] {
    const normalized = stripHeredoc(normalizePatchText(patchText));
    const matches = normalized.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm);
    return Array.from(matches, (match) => match[1] ?? "");
}

export function parsePatch(patchText: string): ParsedPatch[] {
    const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
    const lines = normalized.split("\n");
    const beginIndex = lines[0]?.trim() === "*** Begin Patch" ? 0 : -1;
    const lastLine = lines[lines.length - 1];
    const endIndex = lastLine?.trim() === "*** End Patch" ? lines.length - 1 : -1;

    if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
        throw new Error("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
    }

    const hunks: ParsedPatch[] = [];
    let index = beginIndex + 1;
    while (index < endIndex) {
        const line = lines[index] ?? "";
        if (!line.startsWith("*** ")) {
            index++;
            continue;
        }

        if (line.startsWith("*** Add File: ")) {
            const filePath = line.slice("*** Add File: ".length);
            index++;
            const contentLines: string[] = [];
            while (index < endIndex) {
                const nextLine = lines[index] ?? "";
                if (nextLine.startsWith("*** ")) {
                    break;
                }
                if (!nextLine.startsWith("+")) {
                    throw new Error(`Invalid patch format: Add File lines must start with '+'`);
                }
                contentLines.push(nextLine.slice(1));
                index++;
            }
            hunks.push({
                type: "add",
                filePath,
                content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
            });
            continue;
        }

        if (line.startsWith("*** Delete File: ")) {
            hunks.push({
                type: "delete",
                filePath: line.slice("*** Delete File: ".length),
            });
            index++;
            continue;
        }

        if (line.startsWith("*** Update File: ")) {
            const filePath = line.slice("*** Update File: ".length);
            index++;
            let movePath: string | undefined;
            if ((lines[index] ?? "").startsWith("*** Move to: ")) {
                movePath = (lines[index] ?? "").slice("*** Move to: ".length);
                index++;
            }

            const chunks: PatchChunk[] = [];
            while (index < endIndex) {
                const nextLine = lines[index] ?? "";
                if (nextLine.trim() === "") {
                    index++;
                    continue;
                }
                if (nextLine.startsWith("*** ")) {
                    break;
                }

                const allowMissingContext = chunks.length === 0;
                const changeContexts: string[] = [];
                if (nextLine.startsWith("@@")) {
                    while (index < endIndex) {
                        const contextLine = lines[index] ?? "";
                        if (contextLine === "@@") {
                            index++;
                            continue;
                        }
                        if (contextLine.startsWith("@@ ")) {
                            changeContexts.push(contextLine.slice("@@ ".length));
                            index++;
                            continue;
                        }
                        break;
                    }
                } else if (!allowMissingContext) {
                    throw new Error(`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`);
                }

                const oldLines: string[] = [];
                const newLines: string[] = [];
                let isEndOfFile = false;
                let parsedLines = 0;
                while (index < endIndex) {
                    const hunkLine = lines[index] ?? "";
                    if (hunkLine === "*** End of File") {
                        if (parsedLines === 0) {
                            throw new Error("Update hunk does not contain any lines");
                        }
                        isEndOfFile = true;
                        index++;
                        break;
                    }
                    if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) {
                        break;
                    }
                    const prefix = hunkLine[0];
                    const value = hunkLine.slice(1);
                    if (prefix === undefined) {
                        oldLines.push("");
                        newLines.push("");
                    } else if (prefix === " ") {
                        oldLines.push(value);
                        newLines.push(value);
                    } else if (prefix === "-") {
                        oldLines.push(value);
                    } else if (prefix === "+") {
                        newLines.push(value);
                    } else if (parsedLines > 0) {
                        break;
                    } else {
                        throw new Error(
                            `Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
                        );
                    }
                    parsedLines++;
                    index++;
                }

                if (parsedLines === 0) {
                    throw new Error("Update hunk does not contain any lines");
                }
                chunks.push({ changeContexts, oldLines, newLines, isEndOfFile });
            }
            if (chunks.length === 0 && !movePath) {
                throw new Error(`Update file hunk for path '${filePath}' is empty`);
            }

            hunks.push({ type: "update", filePath, movePath, chunks });
            continue;
        }

        throw new Error(
            `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        );
    }

    return hunks;
}
