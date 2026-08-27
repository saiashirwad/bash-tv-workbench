interface Window {
  bash?: any;
  stopAgent?: (id: string) => unknown;
}

declare module "/editor.js" {
  export function openEditor(...args: any[]): Promise<any>;
  export function editorText(): string;
}
declare module "/markdown.js" {
  export function renderMarkdown(source: unknown): string;
  export function highlightLine(source: unknown, file?: string): string;
}
declare module "/trajectory.js" {
  export function createTrajectoryView(...args: any[]): any;
}
declare module "/workbench-store.js" {
  export function browserStore(...args: any[]): any;
}
declare module "/workflows.js" {
  export function createWorkflowView(...args: any[]): any;
}
declare module "/webmcp.js" {
  export function registerWorkbenchWebMcp(...args: any[]): Promise<any>;
}
declare module "/dom.js" {
  export function $(selector: string, root?: ParentNode): any;
  export function $$(selector: string, root?: ParentNode): any[];
  export function escapeHtml(value?: unknown): string;
  export function encodePathPart(value: unknown): string;
}
declare module "/files.js" {
  export const FilesController: any;
  export const createFilesDomView: any;
  export const fileRoute: any;
  export const filesEditorText: any;
  export const openFilesEditor: any;
}
declare module "/page.mjs" {
  const page: any;
  export default page;
}
