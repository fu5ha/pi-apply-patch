import * as Diff from "diff";

export function createPatchDiff(
    oldContent: string,
    newContent: string,
    contextLines = 4,
): { diff: string; added: number; removed: number } {
    const parts = Diff.diffLines(oldContent, newContent);
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
    const output: string[] = [];
    let oldLineNum = 1;
    let newLineNum = 1;
    let added = 0;
    let removed = 0;
    let lastWasChange = false;

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        if (!part) {
            continue;
        }
        const rawLines = part.value.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
        if (rawLines[rawLines.length - 1] === "") {
            rawLines.pop();
        }

        if (part.added || part.removed) {
            for (const line of rawLines) {
                if (part.added) {
                    output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
                    newLineNum++;
                    added++;
                    continue;
                }

                output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
                oldLineNum++;
                removed++;
            }
            lastWasChange = true;
            continue;
        }

        const nextPart = parts[partIndex + 1];
        const hasLeadingChange = lastWasChange;
        const hasTrailingChange = Boolean(nextPart?.added || nextPart?.removed);

        if (hasLeadingChange && hasTrailingChange) {
            if (rawLines.length <= contextLines * 2) {
                for (const line of rawLines) {
                    output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }
            } else {
                const leadingLines = rawLines.slice(0, contextLines);
                const trailingLines = rawLines.slice(rawLines.length - contextLines);
                const skippedLines = rawLines.length - leadingLines.length - trailingLines.length;

                for (const line of leadingLines) {
                    output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }

                output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                oldLineNum += skippedLines;
                newLineNum += skippedLines;

                for (const line of trailingLines) {
                    output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }
            }
        } else if (hasLeadingChange) {
            const shownLines = rawLines.slice(0, contextLines);
            const skippedLines = rawLines.length - shownLines.length;

            for (const line of shownLines) {
                output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
                oldLineNum++;
                newLineNum++;
            }

            if (skippedLines > 0) {
                output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                oldLineNum += skippedLines;
                newLineNum += skippedLines;
            }
        } else if (hasTrailingChange) {
            const skippedLines = Math.max(0, rawLines.length - contextLines);
            if (skippedLines > 0) {
                output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                oldLineNum += skippedLines;
                newLineNum += skippedLines;
            }

            for (const line of rawLines.slice(skippedLines)) {
                output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
                oldLineNum++;
                newLineNum++;
            }
        } else {
            oldLineNum += rawLines.length;
            newLineNum += rawLines.length;
        }

        lastWasChange = false;
    }

    return { diff: output.join("\n"), added, removed };
}
