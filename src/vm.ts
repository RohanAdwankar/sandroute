export interface VmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The heavy tier. Anything the in-process shell cannot do runs here.
 * The workspace is shared with the in-process tier, so an implementation
 * only has to make the workspace directory visible inside the machine.
 */
export interface VmBackend {
  readonly name: string;
  /** Boot the machine. Called at most once, on the first command that needs it. */
  boot(workspace: string): Promise<void>;
  exec(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<VmResult>;
  stop(): Promise<void>;
}
