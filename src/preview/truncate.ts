import {
    PATCH_PREVIEW_HEAD_LINES,
    PATCH_PREVIEW_MAX_CHARS,
    PATCH_PREVIEW_MAX_LINES,
    PATCH_PREVIEW_TAIL_LINES,
} from "../patch/constants.js";

export function countLines(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    let lines = 1;
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
}

export function truncatePreview(text: string): string {
    if (text.length <= PATCH_PREVIEW_MAX_CHARS && countLines(text) <= PATCH_PREVIEW_MAX_LINES) {
        return text;
    }

    const lines = text.split("\n");
    const head = lines.slice(0, PATCH_PREVIEW_HEAD_LINES);
    const tail = lines.slice(-PATCH_PREVIEW_TAIL_LINES);
    let preview = [...head, "…", ...tail].join("\n");
    if (preview.length > PATCH_PREVIEW_MAX_CHARS) {
        preview = `${preview.slice(0, PATCH_PREVIEW_MAX_CHARS).trimEnd()}\n…`;
    }
    return preview;
}
