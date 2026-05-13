import path from "node:path";
import type { PatchChunk } from "../core_types.js";
import { normalizePatchText } from "./parse.js";

function normalizeSeekLine(line: string): string {
    return line
        .trim()
        .replace(/[‐‑‒–—―−]/g, "-")
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[“”„‟]/g, '"')
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(
    lines: string[],
    pattern: string[],
    start: number,
    eof: boolean,
): { index: number; fuzz: 0 | 1 | 100 | 10000 } | undefined {
    if (pattern.length === 0) {
        return { index: start, fuzz: 0 };
    }
    if (pattern.length > lines.length) {
        return undefined;
    }

    const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
    const lastStart = lines.length - pattern.length;
    const matches = (index: number, compare: (left: string, right: string) => boolean): boolean => {
        for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
            const line = lines[index + patternIndex];
            const expected = pattern[patternIndex];
            if (line === undefined || expected === undefined || !compare(line, expected)) {
                return false;
            }
        }
        return true;
    };

    for (let index = searchStart; index <= lastStart; index++) {
        if (matches(index, (line, expected) => line === expected)) {
            return { index, fuzz: 0 };
        }
    }
    for (let index = searchStart; index <= lastStart; index++) {
        if (matches(index, (line, expected) => line.trimEnd() === expected.trimEnd())) {
            return { index, fuzz: 1 };
        }
    }
    for (let index = searchStart; index <= lastStart; index++) {
        if (matches(index, (line, expected) => line.trim() === expected.trim())) {
            return { index, fuzz: 100 };
        }
    }
    for (let index = searchStart; index <= lastStart; index++) {
        if (matches(index, (line, expected) => normalizeSeekLine(line) === normalizeSeekLine(expected))) {
            return { index, fuzz: 10000 };
        }
    }

    return undefined;
}

function splitFileLines(content: string): string[] {
    const lines = normalizePatchText(content).split("\n");
    if (lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

export function replaceChunks(
    content: string,
    filePath: string,
    chunks: PatchChunk[],
): { content: string; fuzz: number } {
    const originalLines = splitFileLines(content);
    const replacements: {
        start: number;
        oldLength: number;
        newLines: string[];
    }[] = [];
    let lineIndex = 0;
    let fuzz = 0;

    for (const chunk of chunks) {
        for (const changeContext of chunk.changeContexts) {
            const contextMatch = seekSequence(originalLines, [changeContext], lineIndex, false);
            if (contextMatch === undefined) {
                throw new Error(`Failed to find context '${changeContext}' in ${filePath}`);
            }
            fuzz += contextMatch.fuzz;
            lineIndex = contextMatch.index + 1;
        }

        if (chunk.oldLines.length === 0) {
            const insertionIndex =
                originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
            replacements.push({
                start: insertionIndex,
                oldLength: 0,
                newLines: chunk.newLines,
            });
            continue;
        }

        let pattern = chunk.oldLines;
        let newLines = chunk.newLines;
        let foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
        if (foundAt === undefined && pattern[pattern.length - 1] === "") {
            pattern = pattern.slice(0, -1);
            if (newLines[newLines.length - 1] === "") {
                newLines = newLines.slice(0, -1);
            }
            foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
        }

        if (foundAt === undefined) {
            throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
        }

        fuzz += foundAt.fuzz;
        replacements.push({
            start: foundAt.index,
            oldLength: pattern.length,
            newLines,
        });
        lineIndex = foundAt.index + pattern.length;
    }

    const nextLines = [...originalLines];
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
        nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
    }
    nextLines.push("");
    return { content: nextLines.join("\n"), fuzz };
}

export function resolvePatchPath(cwd: string, filePath: string): string {
    return path.resolve(cwd, filePath);
}
