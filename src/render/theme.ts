export type ApplyPatchThemeColor =
    | "accent"
    | "error"
    | "muted"
    | "toolDiffAdded"
    | "toolDiffContext"
    | "toolDiffRemoved"
    | "toolOutput"
    | "toolTitle";

export type ApplyPatchThemeBg = "toolErrorBg" | "toolPendingBg" | "toolSuccessBg";

export type ApplyPatchTheme = {
    fg: (name: ApplyPatchThemeColor, text: string) => string;
    bg: (name: ApplyPatchThemeBg, text: string) => string;
    bold: (text: string) => string;
    inverse: (text: string) => string;
};
