declare module "/editor.js" { export * from "../editor-entry"; }
declare module "/markdown.js" { export * from "../markdown-entry"; }
declare module "/workflows.js" { export function createWorkflowView(store: unknown): any; }
declare module "/trajectory.js" { export function createTrajectoryView(store: unknown): any; }
