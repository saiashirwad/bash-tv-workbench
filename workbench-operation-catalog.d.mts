export type JsonSchema = Readonly<Record<string, unknown>>;
export interface PlatformOperationDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly capability: string;
  readonly scope: "vm" | "project" | "workspace";
  readonly limits: Readonly<{ timeoutMs: number; maxInputBytes: number; maxOutputBytes: number }>;
  readonly annotations: Readonly<{ readOnly: boolean; mutating: boolean; confirmation: boolean }>;
  readonly method: string;
  readonly methodInput?: Readonly<Record<string, unknown>>;
}
export const PLATFORM_OPERATION_CATALOG: readonly PlatformOperationDefinition[];
export const PLATFORM_OPERATIONS: Readonly<Record<string, PlatformOperationDefinition>>;
export function platformOperation(name: string): PlatformOperationDefinition | null;
export function validatePlatformInput(name: string, input: unknown):
  | { readonly ok: true; readonly definition: PlatformOperationDefinition; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: { readonly _tag: string; readonly message: string; readonly operation: string; readonly issues: readonly { readonly path: string; readonly code: string; readonly message: string }[] } };
export function assertPlatformInput(name: string, input: unknown): { readonly ok: true; readonly definition: PlatformOperationDefinition; readonly value: Record<string, unknown> };
