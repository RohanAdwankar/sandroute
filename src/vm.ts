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
  /**
   * Anything still alive in the machine that no command is waiting on -- a server the
   * agent backgrounded, a cron. A backend that cannot tell leaves this undefined and
   * the VM is released on the idle timer alone.
   */
  busy?(): Promise<{ busy: boolean; procs: { pid: number; comm: string }[] }>;
  /**
   * Set by the caller. Reports paths the machine kept its own version of because both
   * sides had changed them since the last exchange; the machine's version wins, and the
   * workspace converges on it.
   */
  onConflict?: (paths: string[]) => void;
  /**
   * Hand the machine back but keep what is in it, so the next boot resumes rather than
   * starts clean. A backend without this is stopped instead, and anything the guest held
   * that the workspace does not cover is lost.
   */
  suspend?(): Promise<void>;
  /** A new task starts: forget the machine's scratch space, which the host keeps while the machine is released. */
  clearScratch?(): void;
  /** Destroy the machine and anything saved from it, whether it is up or suspended. */
  stop(): Promise<void>;
}
