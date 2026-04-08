import { execSync, execFileSync } from 'node:child_process';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WindowInfo = {
  index: number;
  name: string;
};

// ---------------------------------------------------------------------------
// Worktree root (cached)
// ---------------------------------------------------------------------------

let cachedWorktreeRoot: string | undefined;

function getWorktreeRoot(): string {
  if (cachedWorktreeRoot === undefined) {
    cachedWorktreeRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  }
  return cachedWorktreeRoot;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function getSessionName(): string {
  const root = getWorktreeRoot();
  const slug = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '_');
  return `kilo-dev-${slug}`;
}

function sessionExists(sessionName?: string): boolean {
  const name = sessionName ?? getSessionName();
  try {
    execSync(`tmux has-session -t ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findOtherKiloDevSessions(): string[] {
  const ownSession = getSessionName();
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}"', {
      encoding: 'utf-8',
    }).trim();
    if (output === '') return [];
    return output.split('\n').filter(name => name.startsWith('kilo-dev-') && name !== ownSession);
  } catch {
    // tmux server not running or other error
    return [];
  }
}

function createSession(sessionName: string): void {
  const repoRoot = getWorktreeRoot();
  execSync(`tmux new-session -d -s ${sessionName} -n dashboard -c ${repoRoot}`, {
    stdio: 'ignore',
  });
  // Destroy the session when no clients are attached (e.g. terminal window closed).
  // The session starts detached (-d) so we must defer the option via a hook;
  // setting it immediately would destroy the session before any client attaches.
  execSync(
    `tmux set-hook -t ${sessionName} client-attached "set-option -t ${sessionName} destroy-unattached on"`,
    { stdio: 'ignore' }
  );
  // Enable mouse so clicking the status-bar window tabs works
  execSync(`tmux set-option -t ${sessionName} mouse on`, { stdio: 'ignore' });
  // Enable focus events so tmux detects terminal tab switches (needed for client-focus-in hook)
  execSync(`tmux set-option -t ${sessionName} focus-events on`, { stdio: 'ignore' });
  // Copy tmux selection to system clipboard (macOS pbcopy)
  execSync(`tmux set-option -t ${sessionName} set-clipboard on`, { stdio: 'ignore' });
  execSync(
    `tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`,
    { stdio: 'ignore' }
  );
  execSync(
    `tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`,
    { stdio: 'ignore' }
  );
  // Show window list in status bar with more visible formatting
  execSync(`tmux set-option -t ${sessionName} status-position bottom`, { stdio: 'ignore' });
  execSync(`tmux set-option -t ${sessionName} window-status-format " #I:#W "`, { stdio: 'ignore' });
  execSync(`tmux set-option -t ${sessionName} window-status-current-format " #I:#W "`, {
    stdio: 'ignore',
  });
}

function killSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
  } catch {
    // Session doesn't exist — that's fine
  }
}

function attachSession(sessionName: string): void {
  execFileSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function createWindow(sessionName: string, windowName: string): number {
  const output = execSync(
    `tmux new-window -d -t ${sessionName} -n ${windowName} -P -F "#{window_index}"`,
    { encoding: 'utf-8' }
  ).trim();
  return parseInt(output, 10);
}

function paneTarget(sessionName: string, windowTarget: string | number, pane?: number): string {
  return pane !== undefined
    ? `${sessionName}:${windowTarget}.${pane}`
    : `${sessionName}:${windowTarget}`;
}

function sendKeys(
  sessionName: string,
  windowTarget: string | number,
  keys: string,
  pane?: number
): void {
  execSync(
    `tmux send-keys -t ${paneTarget(sessionName, windowTarget, pane)} ${escapeForShell(keys)} Enter`,
    {
      stdio: 'ignore',
    }
  );
}

function sendInterrupt(sessionName: string, windowTarget: string | number, pane?: number): void {
  execSync(`tmux send-keys -t ${paneTarget(sessionName, windowTarget, pane)} C-c`, {
    stdio: 'ignore',
  });
}

function selectWindow(sessionName: string, windowTarget: string | number): void {
  execSync(`tmux select-window -t ${sessionName}:${windowTarget}`, { stdio: 'ignore' });
}

function listWindows(sessionName: string): WindowInfo[] {
  try {
    const output = execSync(
      `tmux list-windows -t ${sessionName} -F "#{window_index}:#{window_name}"`,
      { encoding: 'utf-8' }
    ).trim();
    if (output === '') return [];
    return output.split('\n').map(line => {
      const colonIdx = line.indexOf(':');
      return {
        index: parseInt(line.slice(0, colonIdx), 10),
        name: line.slice(colonIdx + 1),
      };
    });
  } catch {
    return [];
  }
}

function renameWindow(sessionName: string, windowTarget: string | number, newName: string): void {
  execSync(`tmux rename-window -t ${sessionName}:${windowTarget} ${newName}`, { stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// Pane management
// ---------------------------------------------------------------------------

function splitWindowHorizontal(sessionName: string, windowTarget: string | number): void {
  execSync(`tmux split-window -h -t ${sessionName}:${windowTarget}`, { stdio: 'ignore' });
}

/** Split a specific pane top/bottom (vertical split = new pane below). Returns the new pane index. */
function splitPaneVertical(
  sessionName: string,
  windowTarget: string | number,
  pane: number
): number {
  const output = execSync(
    `tmux split-window -v -t ${sessionName}:${windowTarget}.${pane} -P -F "#{pane_index}"`,
    { encoding: 'utf-8' }
  ).trim();
  return parseInt(output, 10);
}

function resizePane(
  sessionName: string,
  windowTarget: string | number,
  pane: number,
  width: number
): void {
  execSync(`tmux resize-pane -t ${sessionName}:${windowTarget}.${pane} -x ${width}`, {
    stdio: 'ignore',
  });
}

/**
 * Apply main-vertical layout with a fixed sidebar width that survives client resizes.
 *
 * main-vertical = large pane on the left, rest stacked vertically on the right.
 * The main-pane-width window option controls pane 0's width; right-column panes
 * share the remainder with equal height automatically.
 *
 * The client-resized hook uses resize-pane to pin pane 0's width — this is more
 * reliable than re-running select-layout because tmux proportionally scales panes
 * before the hook fires, and select-layout may not restore the correct width.
 */
function setMainLeftLayout(
  sessionName: string,
  windowTarget: string | number,
  mainPaneWidth: number
): void {
  const target = `${sessionName}:${windowTarget}`;
  // Tell main-vertical how wide pane 0 should be
  execSync(`tmux set-window-option -t ${target} main-pane-width ${mainPaneWidth}`, {
    stdio: 'ignore',
  });
  // Apply: pane 0 = mainPaneWidth cols, right-column panes equally share the rest
  execSync(`tmux select-layout -t ${target} main-vertical`, { stdio: 'ignore' });
  // Force pane 0 back to the fixed width on resize and on terminal tab switch
  const resizeCmd = `resize-pane -t ${target}.0 -x ${mainPaneWidth}`;
  execSync(`tmux set-hook -t ${sessionName} client-resized "${resizeCmd}"`, { stdio: 'ignore' });
  execSync(`tmux set-hook -t ${sessionName} client-focus-in "${resizeCmd}"`, { stdio: 'ignore' });
}

function swapPane(
  sessionName: string,
  srcWindow: string | number,
  srcPane: number,
  dstWindow: string | number,
  dstPane: number
): void {
  execSync(
    `tmux swap-pane -s ${sessionName}:${srcWindow}.${srcPane} -t ${sessionName}:${dstWindow}.${dstPane}`,
    { stdio: 'ignore' }
  );
}

function killWindow(sessionName: string, windowTarget: string | number): void {
  execSync(`tmux kill-window -t ${sessionName}:${windowTarget}`, { stdio: 'ignore' });
}

/** Kill a single pane (kills the process running in it). */
function killPane(sessionName: string, windowTarget: string | number, pane: number): void {
  execSync(`tmux kill-pane -t ${sessionName}:${windowTarget}.${pane}`, { stdio: 'ignore' });
}

/**
 * Move a pane from its current window into dstWindow, splitting dstPane.
 * The pane's process moves with it — no ghost shells, no pty duplication.
 * -h = new pane to the right of dstPane
 * -v = new pane below dstPane
 */
function joinPane(
  sessionName: string,
  srcWindow: string | number,
  srcPane: number,
  dstWindow: string | number,
  dstPane: number,
  splitDirection: 'h' | 'v'
): void {
  execSync(
    `tmux join-pane -${splitDirection} -s ${sessionName}:${srcWindow}.${srcPane} -t ${sessionName}:${dstWindow}.${dstPane}`,
    { stdio: 'ignore' }
  );
}

/**
 * Move a pane out of its window into a new detached window with the given name.
 * Returns the new window index. The process keeps running in the new window.
 */
function breakPane(
  sessionName: string,
  windowTarget: string | number,
  pane: number,
  newWindowName: string
): number {
  const output = execSync(
    `tmux break-pane -d -s ${sessionName}:${windowTarget}.${pane} -n ${newWindowName} -P -F "#{window_index}"`,
    { encoding: 'utf-8' }
  ).trim();
  return parseInt(output, 10);
}

/** Count panes in a window */
function countPanes(sessionName: string, windowTarget: string | number): number {
  try {
    const output = execSync(
      `tmux list-panes -t ${sessionName}:${windowTarget} -F "#{pane_index}"`,
      { encoding: 'utf-8' }
    ).trim();
    return output === '' ? 0 : output.split('\n').length;
  } catch {
    return 0;
  }
}

type PaneInfo = { windowIndex: number; paneIndex: number };

/**
 * Find which window+pane a service currently occupies across the entire session.
 * Works whether the service is in its own named window or joined into window 0.
 */
function findServicePane(sessionName: string, serviceName: string): PaneInfo | undefined {
  try {
    // Check named windows first (service in its own window)
    const windows = listWindows(sessionName);
    const win = windows.find(w => w.name === serviceName);
    if (win) return { windowIndex: win.index, paneIndex: 0 };
    // Not in a named window — check window 0 panes by title
    const output = execSync(
      `tmux list-panes -t ${sessionName}:0 -F "#{pane_index}:#{pane_title}"`,
      { encoding: 'utf-8' }
    ).trim();
    for (const line of output.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (line.slice(colonIdx + 1) === serviceName) {
        return { windowIndex: 0, paneIndex: parseInt(line.slice(0, colonIdx), 10) };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isPaneRunningCommand(sessionName: string, pane: PaneInfo): boolean {
  try {
    const command = execSync(
      `tmux display-message -p -t ${sessionName}:${pane.windowIndex}.${pane.paneIndex} "#{pane_current_command}"`,
      { encoding: 'utf-8' }
    ).trim();
    const commandName = path.basename(command).replace(/^-/, '');
    return commandName !== '' && !['bash', 'fish', 'nu', 'sh', 'tcsh', 'zsh'].includes(commandName);
  } catch {
    return false;
  }
}

function selectPane(sessionName: string, windowTarget: string | number, pane: number): void {
  execSync(`tmux select-pane -t ${sessionName}:${windowTarget}.${pane}`, { stdio: 'ignore' });
}

/** Set a specific pane's title (shown in pane border when pane-border-status is enabled). */
function setPaneTitle(
  sessionName: string,
  windowTarget: string | number,
  pane: number,
  title: string
): void {
  execSync(
    `tmux select-pane -t ${paneTarget(sessionName, windowTarget, pane)} -T ${escapeForShell(title)}`,
    { stdio: 'ignore' }
  );
}

/** Enable pane border titles on a window. Each pane shows its title in the top border line. */
function enablePaneBorders(sessionName: string, windowTarget: string | number): void {
  const target = `${sessionName}:${windowTarget}`;
  execSync(`tmux set-window-option -t ${target} pane-border-status top`, { stdio: 'ignore' });
  execSync(`tmux set-window-option -t ${target} pane-border-format " #{pane_title} "`, {
    stdio: 'ignore',
  });
  // Prevent shells from overwriting pane titles via OSC escape sequences
  execSync(`tmux set-window-option -t ${target} allow-set-title off`, { stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// Pane logging
// ---------------------------------------------------------------------------

function pipePane(
  sessionName: string,
  windowTarget: string | number,
  pane: number,
  command: string
): void {
  execSync(
    `tmux pipe-pane -t ${paneTarget(sessionName, windowTarget, pane)} -o ${escapeForShell(command)}`,
    { stdio: 'ignore' }
  );
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isInsideTmux(): boolean {
  return process.env.TMUX !== undefined && process.env.TMUX !== '';
}

// Shell-escape a string for use in tmux send-keys
function escapeForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  getSessionName,
  sessionExists,
  findOtherKiloDevSessions,
  createSession,
  killSession,
  attachSession,
  createWindow,
  sendKeys,
  sendInterrupt,
  selectWindow,
  listWindows,
  renameWindow,
  splitWindowHorizontal,
  splitPaneVertical,
  resizePane,
  setMainLeftLayout,
  swapPane,
  killWindow,
  killPane,
  joinPane,
  breakPane,
  countPanes,
  findServicePane,
  isPaneRunningCommand,
  selectPane,
  setPaneTitle,
  enablePaneBorders,
  pipePane,
  isTmuxAvailable,
  isInsideTmux,
};
export type { WindowInfo, PaneInfo };
