import { effect } from "kyoot";

export interface Options {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

export interface Op extends Options {
  readonly command: string;
  readonly args: readonly string[];
}

export interface Output {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CommandError {
  readonly _tag = "CommandError";
  readonly command: string;
  readonly message: string;
  constructor(command: string, message: string) {
    this.command = command;
    this.message = message;
  }
}

const command = effect<Op, Output, CommandError>()("command");

export const handle = command.handle;

export const intercept = command.intercept;

export const run = (name: string, args: readonly string[] = [], options: Options = {}) =>
  command({ command: name, args, ...options });
