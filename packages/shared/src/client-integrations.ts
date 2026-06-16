import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { HOME_DIR, CLIENT_STATE_FILE, getProjectConfigDir } from "./constants";

export const CLIENT_IDS = ["claudeCode", "codex", "pi", "qwenCode", "opencode"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];
export type ClientAction = "enable" | "disable" | "restore";

export interface ClientConfig {
  enabled?: boolean;
  managed?: boolean;
  configPath?: string;
  modelAlias?: string;
  activeAccountId?: string;
  autoSwitchAccounts?: boolean;
  autoRefreshTokens?: boolean;
  quota?: {
    limit5h?: number;
    limit7d?: number;
  };
}

export type ClientsConfig = Partial<Record<ClientId, ClientConfig>>;

export interface ClientStatus {
  id: ClientId;
  name: string;
  enabled: boolean;
  managed: boolean;
  configPath: string;
  exists: boolean;
  activeModel?: string;
  modelAlias?: string;
  details?: string;
}

export interface ClientOperationResult {
  id: ClientId;
  action: ClientAction;
  success: boolean;
  status?: ClientStatus;
  error?: string;
}

export interface ClientApplyResult {
  success: boolean;
  results: ClientOperationResult[];
  clients: ClientStatus[];
  config: Record<string, any>;
}

export interface CodexAccount {
  id: string;
  label: string;
  email?: string;
  plan?: string;
  accountId?: string;
  authMode?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  limitedUntil?: string;
  limitedWindow?: "5h" | "7d" | "unknown";
  limitedReason?: string;
  lastLimitedAt?: string;
  usage?: {
    used5h: number;
    used7d: number;
    limit5h?: number;
    limit7d?: number;
    reset5h?: string;
    reset7d?: string;
  };
}

export interface CodexAccountsResult {
  accounts: CodexAccount[];
  activeAccountId?: string;
  authPath: string;
}

export interface CodexAccountOperationResult extends CodexAccountsResult {
  success: boolean;
  account?: CodexAccount;
  switchedAccount?: CodexAccount;
  config: Record<string, any>;
}

export interface CodexRefreshTokenExportResult {
  success: boolean;
  account: CodexAccount;
  refreshToken: string;
  refreshedAt?: string;
  source: "managed" | "current";
}

export interface CodexTokenRefreshResult {
  id: string;
  label: string;
  refreshed: boolean;
  error?: string;
}

interface ClientDefinition {
  id: ClientId;
  name: string;
  defaultConfig: Required<ClientConfig>;
}

interface ClientOperationOptions {
  updateEnabled?: boolean;
}

interface ClientAdapter {
  status(config: Record<string, any>): ClientStatus;
  enable(config: Record<string, any>): ClientStatus;
  disable(config: Record<string, any>): ClientStatus;
  restore(config: Record<string, any>): ClientStatus;
}

const CLIENT_DEFINITIONS: Record<ClientId, ClientDefinition> = {
  claudeCode: {
    id: "claudeCode",
    name: "Claude Code",
    defaultConfig: {
      enabled: false,
      managed: false,
      configPath: "~/.claude/settings.json",
      modelAlias: "",
      activeAccountId: "",
      autoSwitchAccounts: true,
      autoRefreshTokens: true,
      quota: {},
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    defaultConfig: {
      enabled: false,
      managed: false,
      configPath: "~/.codex/config.toml",
      modelAlias: "ccr-opus",
      activeAccountId: "",
      autoSwitchAccounts: true,
      autoRefreshTokens: true,
      quota: {},
    },
  },
  pi: {
    id: "pi",
    name: "pi",
    defaultConfig: {
      // pi (earendil-works) stores config under a directory, not a single
      // file; the takeover writes models.json + settings.json inside it.
      enabled: false,
      managed: false,
      configPath: "~/.pi/agent",
      modelAlias: "ccr-opus",
      activeAccountId: "",
      autoSwitchAccounts: true,
      autoRefreshTokens: true,
      quota: {},
    },
  },
  qwenCode: {
    id: "qwenCode",
    name: "Qwen Code",
    defaultConfig: {
      // qwen-code (@qwen-code/qwen-code) keeps user settings in
      // ~/.qwen/settings.json; the takeover writes a custom Anthropic
      // modelProvider pointing at the ccr proxy there.
      enabled: false,
      managed: false,
      configPath: "~/.qwen/settings.json",
      modelAlias: "ccr-opus",
      activeAccountId: "",
      autoSwitchAccounts: true,
      autoRefreshTokens: true,
      quota: {},
    },
  },
  opencode: {
    id: "opencode",
    name: "opencode",
    defaultConfig: {
      // opencode (opencode.ai) keeps its config in ~/.config/opencode/
      // opencode.json; the takeover injects a custom Anthropic `provider`
      // pointing at the ccr proxy there.
      enabled: false,
      managed: false,
      configPath: "~/.config/opencode/opencode.json",
      modelAlias: "ccr-opus",
      activeAccountId: "",
      autoSwitchAccounts: true,
      autoRefreshTokens: true,
      quota: {},
    },
  },
};

const CLIENT_BACKUP_DIR = path.join(HOME_DIR, "backups", "clients");
const CODEX_ACCOUNTS_DIR = path.join(HOME_DIR, "codex-accounts");
const CODEX_ACCOUNTS_INDEX_PATH = path.join(CODEX_ACCOUNTS_DIR, "accounts.json");
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Proactively refresh a Codex account's tokens once the access_token is within
// this many seconds of expiry, regardless of whether the account is active.
const CODEX_TOKEN_REFRESH_MARGIN_SECONDS = 24 * 60 * 60;
// Force a refresh at least this often even if the access_token is still valid,
// so the refresh_token itself never goes unused long enough to expire.
const CODEX_TOKEN_REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_STATUSLINE_BACKUP_PATH = path.join(HOME_DIR, ".statusline-backup.json");
const LEGACY_MODEL_BACKUP_PATH = path.join(HOME_DIR, ".model-env-backup.json");
const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_REASONING_MODEL",
];
const CLAUDE_AUTO_COMPACT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
};

// Default context window (in tokens) used to drive client-side auto-compaction
// when the user has not configured a global `ContextWindow`. It feeds both
// Claude Code's CLAUDE_CODE_AUTO_COMPACT_WINDOW and Codex's model_context_window,
// so compaction fires before the routed model overflows. A larger window is not
// always better: it raises cost and can cause context drift.
const DEFAULT_CONTEXT_WINDOW = 200000;

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the configured context window (in tokens) from the global config,
 * falling back to DEFAULT_CONTEXT_WINDOW. Accepts a number or a numeric string.
 */
function getContextWindow(config: Record<string, any>): number {
  const value = config?.ContextWindow;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// --- CCR-managed state -----------------------------------------------------
// Records the exact values CCR last wrote into a client's settings file, so CCR
// can tell apart values it owns (safe to overwrite/clear when the global config
// changes) from values the user hand-edited (must be preserved). The global
// settings.json state lives in one file keyed by clientId; each project's state
// lives in its own ccr-state.json next to settings.local.backup.json.

interface ManagedState {
  autoCompactWindow?: string;
}

/** State file path for a global client takeover (e.g. ~/.claude/settings.json). */
function getGlobalManagedStatePath(): string {
  return CLIENT_STATE_FILE;
}

/** State file path for a project-level takeover (.claude/settings.local.json). */
function getProjectManagedStatePath(projectPath: string): string {
  return path.join(getProjectConfigDir(projectPath), "ccr-state.json");
}

/** Read a per-project managed-state file (a flat ManagedState object). */
function readManagedState(statePath: string): ManagedState {
  return readJsonObject(statePath) as ManagedState;
}

/** Read one clientId's slot from the global managed-state file. */
function readGlobalManagedState(clientId: ClientId): ManagedState {
  const all = readJsonObject(getGlobalManagedStatePath()) as Record<string, ManagedState>;
  return (all && all[clientId]) || {};
}

/** Persist a per-project managed-state file. */
function writeManagedState(statePath: string, value: ManagedState): void {
  writeJsonObject(statePath, value);
}

/** Persist one clientId's slot in the global managed-state file. */
function writeGlobalManagedState(clientId: ClientId, value: ManagedState): void {
  const statePath = getGlobalManagedStatePath();
  const all = readJsonObject(statePath) as Record<string, ManagedState>;
  all[clientId] = value;
  writeJsonObject(statePath, all);
}

/** Clear a per-project managed-state file. */
function clearManagedState(statePath: string): void {
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch {
    // Best-effort; stale state just makes CCR conservative next time.
  }
}

/** Clear one clientId's slot from the global managed-state file. */
function clearGlobalManagedState(clientId: ClientId): void {
  const statePath = getGlobalManagedStatePath();
  const all = readJsonObject(statePath) as Record<string, ManagedState>;
  if (all && all[clientId]) {
    delete all[clientId];
    if (Object.keys(all).length > 0) {
      writeJsonObject(statePath, all);
    } else {
      clearManagedState(statePath);
    }
  }
}

/**
 * Build a ManagedStateAccess backed by the global client-state file for a given
 * client. Used by the global enable/disable path (~/.claude/settings.json).
 */
function globalStateAccess(clientId: ClientId): ManagedStateAccess {
  return {
    read: () => readGlobalManagedState(clientId),
    write: (value) => writeGlobalManagedState(clientId, value),
    clear: () => clearGlobalManagedState(clientId),
  };
}

/**
 * Build a ManagedStateAccess backed by a project's ccr-state.json. Returns
 * undefined when projectPath is absent (no state tracked — apply/remove then
 * fall back to the conservative preserve-on-divergence behavior).
 */
function projectStateAccess(projectPath?: string): ManagedStateAccess | undefined {
  if (!projectPath) return undefined;
  const statePath = getProjectManagedStatePath(projectPath);
  return {
    read: () => readManagedState(statePath),
    write: (value) => writeManagedState(statePath, value),
    clear: () => clearManagedState(statePath),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function getClientDefinition(id: ClientId): ClientDefinition {
  return CLIENT_DEFINITIONS[id];
}

function getRawClientConfig(config: Record<string, any>, id: ClientId): ClientConfig {
  const clients = isObject(config.Clients) ? config.Clients : {};
  const value = clients[id];
  return isObject(value) ? value : {};
}

function hasFamiliesConfig(config: Record<string, any>): boolean {
  const families = config?.Router?.families;
  return isObject(families) && Object.keys(families).length > 0;
}

function getLegacyClaudeEnabled(config: Record<string, any>): boolean {
  return Boolean(config?.StatusLine?.enabled || hasFamiliesConfig(config));
}

export function getDefaultClientsConfig(): ClientsConfig {
  return {
    claudeCode: { ...CLIENT_DEFINITIONS.claudeCode.defaultConfig },
    codex: { ...CLIENT_DEFINITIONS.codex.defaultConfig },
    pi: { ...CLIENT_DEFINITIONS.pi.defaultConfig },
    qwenCode: { ...CLIENT_DEFINITIONS.qwenCode.defaultConfig },
    opencode: { ...CLIENT_DEFINITIONS.opencode.defaultConfig },
  };
}

export function getClientConfig(config: Record<string, any>, id: ClientId): Required<ClientConfig> {
  const definition = getClientDefinition(id);
  const rawConfig = getRawClientConfig(config, id);
  const hasExplicitEnabled = typeof rawConfig.enabled === "boolean";
  const enabled =
    hasExplicitEnabled
      ? Boolean(rawConfig.enabled)
      : id === "claudeCode" && !isObject(config.Clients)
        ? getLegacyClaudeEnabled(config)
        : definition.defaultConfig.enabled;

  return {
    ...definition.defaultConfig,
    ...rawConfig,
    enabled,
    managed: Boolean(rawConfig.managed),
    configPath: rawConfig.configPath || definition.defaultConfig.configPath,
    modelAlias: rawConfig.modelAlias || definition.defaultConfig.modelAlias,
    activeAccountId: rawConfig.activeAccountId || definition.defaultConfig.activeAccountId,
  };
}

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

export function isClientEnabled(config: Record<string, any>, id: ClientId): boolean {
  return getClientConfig(config, id).enabled;
}

function setClientConfig(
  config: Record<string, any>,
  id: ClientId,
  patch: Partial<ClientConfig>
): Required<ClientConfig> {
  const clients = isObject(config.Clients) ? { ...config.Clients } : {};
  const current = getClientConfig(config, id);
  const next = {
    ...current,
    ...patch,
  };
  clients[id] = next;
  config.Clients = clients;
  return next;
}

function getResolvedConfigPath(config: Record<string, any>, id: ClientId): string {
  return expandHome(getClientConfig(config, id).configPath);
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createBackup(clientId: string, filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;

  const backupDir = path.join(CLIENT_BACKUP_DIR, clientId);
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = path.extname(filePath) || ".bak";
  const backupPath = path.join(backupDir, `${timestamp}${ext}`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function getLatestBackupPath(clientId: string): string | null {
  const backupDir = path.join(CLIENT_BACKUP_DIR, clientId);
  if (!fs.existsSync(backupDir)) return null;

  const files = fs
    .readdirSync(backupDir)
    .filter((file) => !file.startsWith("."))
    .sort();

  if (files.length === 0) return null;
  return path.join(backupDir, files[files.length - 1]);
}

function restoreLatestBackup(clientId: string, filePath: string): string | null {
  const backupPath = getLatestBackupPath(clientId);
  if (!backupPath) return null;

  ensureParentDir(filePath);
  fs.copyFileSync(backupPath, filePath);
  return backupPath;
}

function readJsonObject(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};

  // Tolerate a corrupted/truncated state file (user-writable location): treat
  // parse failures as "no state" so takeover/refresh/teardown still work and
  // CCR stays conservative rather than throwing mid-flow.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return isObject(parsed) ? parsed : {};
}

function writeJsonObject(filePath: string, value: Record<string, any>): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function getCcrBaseUrl(config: Record<string, any>, suffix = ""): string {
  const port = config.PORT || 3456;
  return `http://127.0.0.1:${port}${suffix}`;
}

function isCcrBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost):\d+(?:\/.*)?$/i.test(value.trim());
}

function hasExtendedContext(familyConfig: any): boolean {
  return familyConfig?.enableExtendedContext === true;
}

function applyClaudeModelFamilies(settings: Record<string, any>, config: Record<string, any>): void {
  if (!isObject(settings.env)) settings.env = {};

  for (const key of CLAUDE_MODEL_ENV_KEYS) {
    if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
      delete settings.env[key];
    }
  }

  if (!hasFamiliesConfig(config)) return;

  const families = config.Router.families;
  const familyNames = Object.keys(families);
  let primaryFamily: string | null = null;

  for (const family of familyNames) {
    const familyConfig = families[family];
    const extendedSuffix = hasExtendedContext(familyConfig) ? "[1m]" : "";
    const ccrModel = `ccr-${family}${extendedSuffix}`;

    switch (family) {
      case "opus":
        settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "opus";
        break;
      case "sonnet":
        settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "sonnet";
        break;
      case "haiku":
        settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "haiku";
        break;
    }
  }

  const defaultFamily = families.opus ? "opus" : primaryFamily;
  if (defaultFamily) {
    const defaultConfig = families[defaultFamily];
    const extendedSuffix = hasExtendedContext(defaultConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_MODEL = `ccr-${defaultFamily}${extendedSuffix}`;
  }

  const thinkFamily = familyNames.find((family) => families[family]?.think);
  if (thinkFamily) {
    const thinkConfig = families[thinkFamily];
    const extendedSuffix = hasExtendedContext(thinkConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_REASONING_MODEL = `ccr-${thinkFamily}${extendedSuffix}`;
  } else if (primaryFamily) {
    const primaryConfig = families[primaryFamily];
    const extendedSuffix = hasExtendedContext(primaryConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_REASONING_MODEL = `ccr-${primaryFamily}${extendedSuffix}`;
  }
}

/**
 * Accessor for the managed-state slot backing a given takeover target (global
 * settings.json keyed by clientId, or a per-project ccr-state.json). Lets
 * apply/remove read what CCR last wrote and update/clear it, without each call
 * site needing to know which storage layout is in use.
 */
interface ManagedStateAccess {
  read(): ManagedState;
  write(value: ManagedState): void;
  clear(): void;
}

function applyClaudeAutoCompactSettings(
  settings: Record<string, any>,
  config: Record<string, any>,
  state?: ManagedStateAccess,
): void {
  settings.autoCompactEnabled = true;
  if (!isObject(settings.env)) settings.env = {};
  if (settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === "0.8") {
    delete settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  }

  // Auto-compact window: preserve a value the user hand-edited. CCR only writes
  // (and updates) when the field is absent or still holds the value CCR last
  // wrote. A divergent value means the user customized it — keep it and leave
  // the recorded state untouched so the divergence stays detectable next time.
  //
  // State can be missing after a disable->enable cycle (disable clears it, and
  // a stale managed window restored from the backup used to be mistaken for a
  // user value, so the state was never rebuilt — freezing the window). When the
  // state is empty but the current value matches what CCR would write for the
  // current config, treat it as CCR-managed and re-establish the state so the
  // window stays manageable. A genuinely divergent value with no state is still
  // treated as a user customization and left untouched.
  const managedWindow = String(getContextWindow(config));
  const currentWindow = settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const lastWrittenWindow = state?.read().autoCompactWindow;
  const isManaged =
    currentWindow === undefined ||
    currentWindow === lastWrittenWindow ||
    (lastWrittenWindow === undefined && currentWindow === managedWindow);
  if (isManaged) {
    settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = managedWindow;
    state?.write({ autoCompactWindow: managedWindow });
  }

  // PCT has a fixed CCR default, so a plain value comparison is enough to tell
  // CCR-managed from user-customized; no state file needed for it.
  const defaultPct = CLAUDE_AUTO_COMPACT_ENV.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (
    settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === undefined ||
    settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === defaultPct
  ) {
    settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = defaultPct;
  }
}

function applyClaudeAttributionHeader(settings: Record<string, any>, config: Record<string, any>): void {
  if (!isObject(settings.env)) settings.env = {};
  // Strip Claude Code's dynamic attribution header (client version + prompt
  // fingerprint) while CCR is taking over, so the upstream prompt-cache prefix
  // stays stable. Enabled by default; opt out with `disableAttributionHeader: false`.
  if (config.disableAttributionHeader === false) {
    delete settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  } else {
    settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  }
}

function restoreLegacyClaudeBackups(settings: Record<string, any>): void {
  if (settings.statusLine?.command === "ccr statusline" && fs.existsSync(LEGACY_STATUSLINE_BACKUP_PATH)) {
    try {
      const backup = JSON.parse(fs.readFileSync(LEGACY_STATUSLINE_BACKUP_PATH, "utf-8"));
      settings.statusLine = backup;
      fs.unlinkSync(LEGACY_STATUSLINE_BACKUP_PATH);
    } catch {
      delete settings.statusLine;
    }
  }

  if (fs.existsSync(LEGACY_MODEL_BACKUP_PATH)) {
    try {
      const backup = JSON.parse(fs.readFileSync(LEGACY_MODEL_BACKUP_PATH, "utf-8"));
      if (!isObject(settings.env)) settings.env = {};
      for (const [key, value] of Object.entries(backup)) {
        settings.env[key] = value;
      }
      fs.unlinkSync(LEGACY_MODEL_BACKUP_PATH);
    } catch {
      // Fall through to managed field cleanup below.
    }
  }
}

function removeClaudeManagedFields(settings: Record<string, any>, state?: ManagedStateAccess): void {
  restoreLegacyClaudeBackups(settings);

  if (isObject(settings.env)) {
    const baseUrlWasManaged = isCcrBaseUrl(settings.env.ANTHROPIC_BASE_URL);
    if (baseUrlWasManaged) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
        delete settings.env[key];
      }
    }

    // Auto-compact window: only remove it if it still holds the value CCR last
    // wrote. A divergent value is a user customization — keep it. Always clear
    // the recorded state for this target afterward.
    const lastWrittenWindow = state?.read().autoCompactWindow;
    if (settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === lastWrittenWindow) {
      delete settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
    state?.clear();
    for (const [key, value] of Object.entries(CLAUDE_AUTO_COMPACT_ENV)) {
      if (key === "CLAUDE_CODE_AUTO_COMPACT_WINDOW") continue;
      if (settings.env[key] === value) {
        delete settings.env[key];
      }
    }

    // Remove the attribution header override injected by CCR.
    delete settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER;

    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }

  if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }

  if (settings.autoCompactEnabled === true) {
    delete settings.autoCompactEnabled;
  }
}

function getClaudeActiveModel(settings: Record<string, any>): string | undefined {
  const env = isObject(settings.env) ? settings.env : {};
  return (
    env.ANTHROPIC_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  );
}

function isClaudeManaged(settings: Record<string, any>): boolean {
  const env = isObject(settings.env) ? settings.env : {};
  return Boolean(
    isCcrBaseUrl(env.ANTHROPIC_BASE_URL) ||
    CLAUDE_MODEL_ENV_KEYS.some((key) => typeof env[key] === "string" && env[key].startsWith("ccr-")) ||
    settings.statusLine?.command === "ccr statusline"
  );
}

function createClaudeStatus(config: Record<string, any>, settings?: Record<string, any>, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "claudeCode");
  const filePath = getResolvedConfigPath(config, "claudeCode");
  const safeSettings = settings || {};

  return {
    id: "claudeCode",
    name: CLIENT_DEFINITIONS.claudeCode.name,
    enabled: clientConfig.enabled,
    managed: isClaudeManaged(safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: getClaudeActiveModel(safeSettings),
    details,
  };
}

const claudeCodeAdapter: ClientAdapter = {
  status(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    try {
      return createClaudeStatus(config, readJsonObject(filePath));
    } catch (error) {
      return createClaudeStatus(config, {}, errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("claudeCode", filePath);
    }

    const settings = readJsonObject(filePath);
    if (!isObject(settings.env)) settings.env = {};

    settings.env.ANTHROPIC_BASE_URL = getCcrBaseUrl(config);
    settings.env.ANTHROPIC_AUTH_TOKEN = config.APIKEY || "test";
    applyClaudeModelFamilies(settings, config);
    applyClaudeAutoCompactSettings(settings, config, globalStateAccess("claudeCode"));
    applyClaudeAttributionHeader(settings, config);

    if (config?.StatusLine?.enabled) {
      settings.statusLine = {
        type: "command",
        command: "ccr statusline",
        padding: 0,
      };
    } else if (settings.statusLine?.command === "ccr statusline") {
      delete settings.statusLine;
    }

    writeJsonObject(filePath, settings);
    return createClaudeStatus(config, settings);
  },

  disable(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    if (restoreLatestBackup("claudeCode", filePath)) {
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }

    const settings = readJsonObject(filePath);
    removeClaudeManagedFields(settings, globalStateAccess("claudeCode"));
    writeJsonObject(filePath, settings);
    return createClaudeStatus(config, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/**
 * Apply ccr takeover settings (base URL, auth token, model family routing,
 * auto-compact, status line) to a project's `.claude/settings.local.json`,
 * mirroring what `claudeCodeAdapter.enable` does for `~/.claude/settings.json`.
 */
export function applyCcrProjectTakeover(
  settings: Record<string, any>,
  config: Record<string, any>,
  projectPath?: string,
): void {
  if (!isObject(settings.env)) settings.env = {};

  settings.env.ANTHROPIC_BASE_URL = getCcrBaseUrl(config);
  settings.env.ANTHROPIC_AUTH_TOKEN = config.APIKEY || "test";
  applyClaudeModelFamilies(settings, config);
  applyClaudeAutoCompactSettings(settings, config, projectStateAccess(projectPath));
  applyClaudeAttributionHeader(settings, config);

  if (config?.StatusLine?.enabled) {
    settings.statusLine = {
      type: "command",
      command: "ccr statusline",
      padding: 0,
    };
  } else if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }
}

/**
 * Remove ccr-managed fields from a project's `.claude/settings.local.json`,
 * preserving any unrelated settings (permissions, hooks, etc.).
 */
export function removeCcrProjectTakeover(
  settings: Record<string, any>,
  projectPath?: string,
  config?: Record<string, any>,
): void {
  const state = projectStateAccess(projectPath);
  if (isObject(settings.env)) {
    if (isCcrBaseUrl(settings.env.ANTHROPIC_BASE_URL)) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
        delete settings.env[key];
      }
    }

    // Auto-compact window: remove it if it still holds the value CCR last wrote,
    // OR — when the state is missing (e.g. after a prior disable->enable cycle
    // failed to rebuild it) — if it matches the value CCR would write for the
    // current config. A divergent value is a user customization — keep it.
    // Always clear the recorded state for this project afterward.
    const lastWrittenWindow = state?.read().autoCompactWindow;
    const currentWindow = settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const managedWindow = config ? String(getContextWindow(config)) : undefined;
    const shouldRemove =
      currentWindow === lastWrittenWindow ||
      (lastWrittenWindow === undefined && managedWindow !== undefined && currentWindow === managedWindow);
    if (shouldRemove) {
      delete settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
    state?.clear();
    for (const [key, value] of Object.entries(CLAUDE_AUTO_COMPACT_ENV)) {
      if (key === "CLAUDE_CODE_AUTO_COMPACT_WINDOW") continue;
      if (settings.env[key] === value) {
        delete settings.env[key];
      }
    }

    // Remove the attribution header override injected by CCR.
    delete settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER;

    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }

  if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }

  if (settings.autoCompactEnabled === true) {
    delete settings.autoCompactEnabled;
  }
}

/**
 * Whether a project's `.claude/settings.local.json` is currently taken over by ccr.
 */
export function isCcrProjectTakeoverActive(settings: Record<string, any>): boolean {
  return isClaudeManaged(settings);
}

function parseTomlString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
  if (quoted) {
    return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const singleQuoted = trimmed.match(/^'([^']*)'/);
  if (singleQuoted) return singleQuoted[1];
  const bare = trimmed.match(/^([^#\s]+)/);
  return bare?.[1];
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inDouble) {
      escaped = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, index);
    }
  }

  return line;
}

function getTopLevelTomlValue(content: string, key: string): string | undefined {
  let inSection = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) continue;

    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (match?.[1] === key) {
      return parseTomlString(match[2]);
    }
  }
  return undefined;
}

function hasTomlSection(content: string, sectionName: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => stripTomlComment(line).trim() === `[${sectionName}]`);
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Numbers are emitted as bare TOML integers/floats; strings are quoted.
function formatTomlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : quoteTomlString(value);
}

function setTopLevelTomlValues(content: string, values: Record<string, string | number>): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const replaced = new Set<string>();
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  const topLevelEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let index = 0; index < topLevelEnd; index += 1) {
    const match = stripTomlComment(lines[index]).trim().match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      lines[index] = `${match[1]} = ${formatTomlValue(values[match[1]])}`;
      replaced.add(match[1]);
    }
  }

  const missing = Object.entries(values)
    .filter(([key]) => !replaced.has(key))
    .map(([key, value]) => `${key} = ${formatTomlValue(value)}`);

  if (missing.length > 0) {
    lines.splice(topLevelEnd, 0, ...missing, topLevelEnd === 0 ? "" : "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function removeTomlSection(content: string, sectionName: string): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inTargetSection = false;

  for (const line of lines) {
    const sectionMatch = stripTomlComment(line).trim().match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const currentSection = sectionMatch[1];
      inTargetSection =
        currentSection === sectionName || currentSection.startsWith(`${sectionName}.`);
      if (inTargetSection) continue;
    }

    if (!inTargetSection) {
      output.push(line);
    }
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function removeTopLevelTomlKeys(content: string, keys: Set<string>): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inSection = true;
      output.push(line);
      continue;
    }

    const match = !inSection ? trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/) : null;
    if (match && keys.has(match[1])) {
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function getCodexContent(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function writeCodexContent(filePath: string, content: string): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${content.trimEnd()}\n`, "utf-8");
}

function getCodexAuthPath(config: Record<string, any>): string {
  return path.join(path.dirname(getResolvedConfigPath(config, "codex")), "auth.json");
}

function safeAccountId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return normalized || `account-${Date.now()}`;
}

function readCodexAccountsIndex(): Omit<CodexAccount, "active">[] {
  if (!fs.existsSync(CODEX_ACCOUNTS_INDEX_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(CODEX_ACCOUNTS_INDEX_PATH, "utf-8"));
  if (!Array.isArray(parsed?.accounts)) return [];
  return parsed.accounts.filter(isObject).map((account: any) => ({
    id: String(account.id || ""),
    label: String(account.label || account.email || account.accountId || "Codex Account"),
    email: typeof account.email === "string" ? account.email : undefined,
    plan: typeof account.plan === "string" ? account.plan : undefined,
    accountId: typeof account.accountId === "string" ? account.accountId : undefined,
    authMode: typeof account.authMode === "string" ? account.authMode : undefined,
    createdAt: typeof account.createdAt === "string" ? account.createdAt : new Date().toISOString(),
    updatedAt: typeof account.updatedAt === "string" ? account.updatedAt : new Date().toISOString(),
    lastUsedAt: typeof account.lastUsedAt === "string" ? account.lastUsedAt : undefined,
    limitedUntil: typeof account.limitedUntil === "string" ? account.limitedUntil : undefined,
    limitedWindow: ["5h", "7d", "unknown"].includes(account.limitedWindow) ? account.limitedWindow : undefined,
    limitedReason: typeof account.limitedReason === "string" ? account.limitedReason : undefined,
    lastLimitedAt: typeof account.lastLimitedAt === "string" ? account.lastLimitedAt : undefined,
  })).filter((account: Omit<CodexAccount, "active">) => account.id);
}

function writeCodexAccountsIndex(accounts: Omit<CodexAccount, "active">[]): void {
  fs.mkdirSync(CODEX_ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(
    CODEX_ACCOUNTS_INDEX_PATH,
    `${JSON.stringify({ accounts }, null, 2)}\n`,
    "utf-8"
  );
  try {
    fs.chmodSync(CODEX_ACCOUNTS_INDEX_PATH, 0o600);
  } catch {
    // Best effort on platforms that support POSIX permissions.
  }
}

function getCodexAccountAuthPath(accountId: string): string {
  return path.join(CODEX_ACCOUNTS_DIR, `${accountId}.auth.json`);
}

function decodeJwtPayload(token: unknown): Record<string, any> {
  if (typeof token !== "string") return {};
  const [, payload] = token.split(".");
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getOpenAiAuthClaims(payload: Record<string, any>): Record<string, any> {
  const claims = payload["https://api.openai.com/auth"];
  return isObject(claims) ? claims : {};
}

function getOpenAiProfileClaims(payload: Record<string, any>): Record<string, any> {
  const claims = payload["https://api.openai.com/profile"];
  return isObject(claims) ? claims : {};
}

function extractCodexAuthMetadata(auth: Record<string, any>): {
  email?: string;
  plan?: string;
  accountId?: string;
  authMode?: string;
} {
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  const idPayload = decodeJwtPayload(tokens.id_token);
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const idAuth = getOpenAiAuthClaims(idPayload);
  const accessAuth = getOpenAiAuthClaims(accessPayload);
  const profile = getOpenAiProfileClaims(accessPayload);

  return {
    email:
      (typeof profile.email === "string" && profile.email) ||
      (typeof idPayload.email === "string" && idPayload.email) ||
      undefined,
    plan:
      (typeof accessAuth.chatgpt_plan_type === "string" && accessAuth.chatgpt_plan_type) ||
      (typeof idAuth.chatgpt_plan_type === "string" && idAuth.chatgpt_plan_type) ||
      undefined,
    accountId:
      (typeof tokens.account_id === "string" && tokens.account_id) ||
      (typeof accessAuth.chatgpt_account_id === "string" && accessAuth.chatgpt_account_id) ||
      (typeof idAuth.chatgpt_account_id === "string" && idAuth.chatgpt_account_id) ||
      undefined,
    authMode: typeof auth.auth_mode === "string" ? auth.auth_mode : undefined,
  };
}

function readCodexAuthObject(authPath: string): Record<string, any> {
  if (!fs.existsSync(authPath)) {
    throw new Error(`Codex auth file not found: ${authPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  if (!isObject(parsed)) {
    throw new Error(`Codex auth file is not a JSON object: ${authPath}`);
  }
  return parsed;
}

function writeCodexAuthObject(authPath: string, auth: Record<string, any>): void {
  ensureParentDir(authPath);
  fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf-8");
  try {
    fs.chmodSync(authPath, 0o600);
  } catch {
    // Best effort on platforms that support POSIX permissions.
  }
}

function getCodexAuthRefreshToken(auth: Record<string, any>): string | undefined {
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  return typeof tokens.refresh_token === "string" && tokens.refresh_token.trim()
    ? tokens.refresh_token.trim()
    : undefined;
}

function getCodexAuthRefreshTime(auth: Record<string, any>): number {
  const raw = typeof auth.last_refresh === "string" ? auth.last_refresh : "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCodexAccessTokenExpiry(auth: Record<string, any>): number | undefined {
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  const payload = decodeJwtPayload(tokens.access_token);
  return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
}

function isSameCodexAccount(auth: Record<string, any>, account: Omit<CodexAccount, "active">): boolean {
  const metadata = extractCodexAuthMetadata(auth);
  if (metadata.accountId && account.accountId && metadata.accountId === account.accountId) return true;
  if (metadata.email && account.email && metadata.email === account.email) return true;
  return safeAccountId(metadata.accountId || metadata.email || "") === account.id;
}

function getActiveCodexAccountId(config: Record<string, any>): string | undefined {
  const active = getRawClientConfig(config, "codex").activeAccountId;
  return typeof active === "string" && active ? active : undefined;
}

function setActiveCodexAccountId(config: Record<string, any>, accountId: string | undefined): void {
  setClientConfig(config, "codex", { activeAccountId: accountId } as Partial<ClientConfig>);
}

function isCodexAccountCoolingDown(account: Pick<CodexAccount, "limitedUntil">, now = Date.now()): boolean {
  if (!account.limitedUntil) return false;
  const limitedUntil = Date.parse(account.limitedUntil);
  return Number.isFinite(limitedUntil) && limitedUntil > now;
}

function withExpiredCodexLimitsCleared(
  accounts: Omit<CodexAccount, "active">[],
  now = Date.now()
): Omit<CodexAccount, "active">[] {
  let changed = false;
  const next = accounts.map((account) => {
    if (!account.limitedUntil || isCodexAccountCoolingDown(account, now)) {
      return account;
    }
    changed = true;
    const { limitedUntil, limitedWindow, limitedReason, ...rest } = account;
    return rest;
  });
  if (changed) writeCodexAccountsIndex(next);
  return next;
}

function toCodexAccountsResult(config: Record<string, any>): CodexAccountsResult {
  const activeAccountId = getActiveCodexAccountId(config);
  const accounts = withExpiredCodexLimitsCleared(readCodexAccountsIndex());
  return {
    accounts: accounts.map((account) => ({
      ...account,
      active: account.id === activeAccountId,
    })),
    activeAccountId,
    authPath: getCodexAuthPath(config),
  };
}

export function listCodexAccounts(config: Record<string, any>): CodexAccountsResult {
  return toCodexAccountsResult(config);
}

export function getActiveCodexAccount(config: Record<string, any>): CodexAccount | undefined {
  const activeAccountId = getActiveCodexAccountId(config);
  return toCodexAccountsResult(config).accounts.find((account) => account.id === activeAccountId);
}

function inferCodexLimitWindow(reason?: string): "5h" | "7d" | "unknown" {
  const text = (reason || "").toLowerCase();
  if (/(5\s*h|5\s*hour|five\s*hour|5小时|5 小时)/i.test(text)) return "5h";
  if (/(7\s*d|7\s*day|seven\s*day|weekly|week|7天|7 天|一周)/i.test(text)) return "7d";
  return "unknown";
}

function inferCodexRetryAfterSeconds(reason?: string): number {
  const window = inferCodexLimitWindow(reason);
  if (window === "7d") return 7 * 24 * 60 * 60;
  if (window === "5h") return 5 * 60 * 60;
  return 5 * 60 * 60;
}

export function markActiveCodexAccountLimitedAndSwitch(
  config: Record<string, any>,
  reason?: string,
  retryAfterSeconds?: number
): CodexAccountOperationResult {
  const activeAccountId = getActiveCodexAccountId(config);
  const rawAccounts = withExpiredCodexLimitsCleared(readCodexAccountsIndex());
  const activeIndex = rawAccounts.findIndex((account) => account.id === activeAccountId);
  const now = new Date();
  const limitedUntil = new Date(
    now.getTime() + Math.max(60, retryAfterSeconds || inferCodexRetryAfterSeconds(reason)) * 1000
  ).toISOString();

  const accounts = rawAccounts.map((account, index) => (
    index === activeIndex
      ? {
          ...account,
          limitedUntil,
          limitedWindow: inferCodexLimitWindow(reason),
          limitedReason: reason,
          lastLimitedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
      : account
  ));

  let switchedAccount: Omit<CodexAccount, "active"> | undefined;
  if (activeIndex >= 0) {
    const ordered = [
      ...accounts.slice(activeIndex + 1),
      ...accounts.slice(0, activeIndex),
    ];
    switchedAccount = ordered.find((account) => !isCodexAccountCoolingDown(account, now.getTime()));
  } else {
    switchedAccount = accounts.find((account) => !isCodexAccountCoolingDown(account, now.getTime()));
  }

  writeCodexAccountsIndex(accounts);

  if (switchedAccount) {
    const storedAuthPath = getCodexAccountAuthPath(switchedAccount.id);
    if (fs.existsSync(storedAuthPath)) {
      const authPath = getCodexAuthPath(config);
      createBackup("codex-auth", authPath);
      writeCodexAuthObject(authPath, readCodexAuthObject(storedAuthPath));
      setActiveCodexAccountId(config, switchedAccount.id);
    }
  }

  const result = toCodexAccountsResult(config);
  return {
    ...result,
    success: Boolean(switchedAccount),
    account: activeAccountId ? result.accounts.find((item) => item.id === activeAccountId) : undefined,
    switchedAccount: switchedAccount ? result.accounts.find((item) => item.id === switchedAccount.id) : undefined,
    config,
  };
}

function persistCodexAccountAuth(
  config: Record<string, any>,
  auth: Record<string, any>,
  label?: string
): CodexAccountOperationResult {
  const metadata = extractCodexAuthMetadata(auth);
  const hash = crypto.createHash("sha256").update(JSON.stringify(auth)).digest("hex").slice(0, 12);
  const id = safeAccountId(metadata.accountId || metadata.email || hash);
  const now = new Date().toISOString();
  const accounts = readCodexAccountsIndex();
  const existingIndex = accounts.findIndex((account) => account.id === id);
  const existing = existingIndex >= 0 ? accounts[existingIndex] : undefined;
  const account: Omit<CodexAccount, "active"> = {
    id,
    label: label?.trim() || existing?.label || metadata.email || metadata.accountId || "Codex Account",
    email: metadata.email,
    plan: metadata.plan,
    accountId: metadata.accountId,
    authMode: metadata.authMode,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: now,
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = account;
  } else {
    accounts.push(account);
  }

  fs.mkdirSync(CODEX_ACCOUNTS_DIR, { recursive: true });
  writeCodexAuthObject(getCodexAccountAuthPath(id), auth);
  writeCodexAccountsIndex(accounts);

  const authPath = getCodexAuthPath(config);
  const nextAuthContent = `${JSON.stringify(auth, null, 2)}\n`;
  const currentAuthContent = fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf-8") : "";
  if (currentAuthContent !== nextAuthContent) {
    createBackup("codex-auth", authPath);
    writeCodexAuthObject(authPath, auth);
  }
  setActiveCodexAccountId(config, id);

  const result = toCodexAccountsResult(config);
  return {
    ...result,
    success: true,
    account: result.accounts.find((item) => item.id === id),
    config,
  };
}

export function importCurrentCodexAccount(
  config: Record<string, any>,
  label?: string
): CodexAccountOperationResult {
  const auth = readCodexAuthObject(getCodexAuthPath(config));
  return persistCodexAccountAuth(config, auth, label);
}

export function exportCodexRefreshToken(
  config: Record<string, any>,
  accountId?: string
): CodexRefreshTokenExportResult {
  const targetAccountId = accountId || getActiveCodexAccountId(config);
  if (!targetAccountId) {
    throw new Error("No active Codex account. Specify an account id or activate one first.");
  }

  const accounts = readCodexAccountsIndex();
  const account = accounts.find((item) => item.id === targetAccountId);
  if (!account) {
    throw new Error(`Unknown Codex account: ${targetAccountId}`);
  }

  const storedAuthPath = getCodexAccountAuthPath(targetAccountId);
  if (!fs.existsSync(storedAuthPath)) {
    throw new Error(`Stored Codex auth file not found: ${storedAuthPath}`);
  }

  const candidates: Array<{ auth: Record<string, any>; source: "managed" | "current"; refreshedAt: number }> = [
    {
      auth: readCodexAuthObject(storedAuthPath),
      source: "managed",
      refreshedAt: 0,
    },
  ];
  candidates[0].refreshedAt = getCodexAuthRefreshTime(candidates[0].auth);

  const currentAuthPath = getCodexAuthPath(config);
  if (getActiveCodexAccountId(config) === targetAccountId && fs.existsSync(currentAuthPath)) {
    try {
      const currentAuth = readCodexAuthObject(currentAuthPath);
      if (isSameCodexAccount(currentAuth, account)) {
        candidates.push({
          auth: currentAuth,
          source: "current",
          refreshedAt: getCodexAuthRefreshTime(currentAuth),
        });
      }
    } catch {
      // Ignore malformed current auth and fall back to the managed snapshot.
    }
  }

  const latest = candidates
    .filter((candidate) => getCodexAuthRefreshToken(candidate.auth))
    .sort((a, b) => b.refreshedAt - a.refreshedAt)[0];

  if (!latest) {
    throw new Error(`No refresh token found for Codex account: ${targetAccountId}`);
  }

  if (latest.source === "current") {
    const storedRefreshTime = getCodexAuthRefreshTime(candidates[0].auth);
    if (latest.refreshedAt > storedRefreshTime) {
      writeCodexAuthObject(storedAuthPath, latest.auth);
      const now = new Date().toISOString();
      writeCodexAccountsIndex(accounts.map((item) => (
        item.id === targetAccountId
          ? { ...item, lastUsedAt: now, updatedAt: now }
          : item
      )));
    }
  }

  const result = toCodexAccountsResult(config);
  const resultAccount = result.accounts.find((item) => item.id === targetAccountId);
  if (!resultAccount) {
    throw new Error(`Unknown Codex account: ${targetAccountId}`);
  }

  return {
    success: true,
    account: resultAccount,
    refreshToken: getCodexAuthRefreshToken(latest.auth)!,
    refreshedAt: typeof latest.auth.last_refresh === "string" ? latest.auth.last_refresh : undefined,
    source: latest.source,
  };
}

async function exchangeCodexRefreshToken(refreshToken: string): Promise<Record<string, any>> {
  const token = refreshToken.trim();
  if (!token) {
    throw new Error("Refresh token is required");
  }

  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
  });

  const text = await response.text();
  let data: Record<string, any> = {};
  try {
    const parsed = text ? JSON.parse(text) : {};
    data = isObject(parsed) ? parsed : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const message =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      text ||
      `HTTP ${response.status}`;
    throw new Error(`Failed to exchange Codex refresh token: ${message}`);
  }

  if (typeof data.access_token !== "string" || typeof data.id_token !== "string") {
    throw new Error("Refresh token exchange did not return Codex access and ID tokens");
  }

  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: data.id_token,
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : token,
      account_id: undefined as string | undefined,
    },
    last_refresh: new Date().toISOString(),
  };
  const metadata = extractCodexAuthMetadata(auth);
  auth.tokens.account_id = metadata.accountId;
  return auth;
}

export async function importCodexAccountFromRefreshToken(
  config: Record<string, any>,
  refreshToken: string,
  label?: string
): Promise<CodexAccountOperationResult> {
  const auth = await exchangeCodexRefreshToken(refreshToken);
  return persistCodexAccountAuth(config, auth, label);
}

/**
 * Exchange a managed Codex account's stored refresh_token for a fresh
 * access_token/refresh_token pair and persist the result, independent of
 * whether the account is currently active.
 *
 * If the account is the active one and `~/.codex/auth.json` holds a newer
 * `last_refresh` (e.g. the official Codex CLI already refreshed it during
 * use), that newer refresh_token is exchanged instead so the stored snapshot
 * never refreshes with a stale/already-rotated token. The refreshed tokens
 * are written back to the managed snapshot and, for the active account,
 * also synced to `~/.codex/auth.json`.
 */
export async function refreshCodexAccountTokens(
  config: Record<string, any>,
  accountId: string
): Promise<CodexAccountOperationResult> {
  const accounts = readCodexAccountsIndex();
  const account = accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error(`Unknown Codex account: ${accountId}`);
  }

  const storedAuthPath = getCodexAccountAuthPath(accountId);
  if (!fs.existsSync(storedAuthPath)) {
    throw new Error(`Stored Codex auth file not found: ${storedAuthPath}`);
  }

  const storedAuth = readCodexAuthObject(storedAuthPath);
  let sourceAuth = storedAuth;

  const isActive = getActiveCodexAccountId(config) === accountId;
  const currentAuthPath = getCodexAuthPath(config);
  if (isActive && fs.existsSync(currentAuthPath)) {
    try {
      const currentAuth = readCodexAuthObject(currentAuthPath);
      if (
        isSameCodexAccount(currentAuth, account) &&
        getCodexAuthRefreshTime(currentAuth) > getCodexAuthRefreshTime(storedAuth)
      ) {
        sourceAuth = currentAuth;
      }
    } catch {
      // Ignore malformed current auth and fall back to the managed snapshot.
    }
  }

  const refreshToken = getCodexAuthRefreshToken(sourceAuth);
  if (!refreshToken) {
    throw new Error(`No refresh token found for Codex account: ${accountId}`);
  }

  const refreshedAuth = await exchangeCodexRefreshToken(refreshToken);
  writeCodexAuthObject(storedAuthPath, refreshedAuth);

  const metadata = extractCodexAuthMetadata(refreshedAuth);
  const accountIndex = accounts.findIndex((item) => item.id === accountId);
  accounts[accountIndex] = {
    ...accounts[accountIndex],
    email: metadata.email || accounts[accountIndex].email,
    plan: metadata.plan || accounts[accountIndex].plan,
    accountId: metadata.accountId || accounts[accountIndex].accountId,
    authMode: metadata.authMode || accounts[accountIndex].authMode,
    updatedAt: new Date().toISOString(),
  };
  writeCodexAccountsIndex(accounts);

  if (isActive) {
    createBackup("codex-auth", currentAuthPath);
    writeCodexAuthObject(currentAuthPath, refreshedAuth);
  }

  const result = toCodexAccountsResult(config);
  return {
    ...result,
    success: true,
    account: result.accounts.find((item) => item.id === accountId),
    config,
  };
}

/**
 * Refresh tokens for every managed Codex account whose access_token is close
 * to expiry or whose tokens haven't been refreshed in a long time, regardless
 * of whether the account is currently active. Intended to be called
 * periodically so refresh_tokens never go unused long enough to expire.
 */
export async function refreshDueCodexAccounts(
  config: Record<string, any>,
  options?: { marginSeconds?: number; maxAgeMs?: number }
): Promise<CodexTokenRefreshResult[]> {
  const marginMs = (options?.marginSeconds ?? CODEX_TOKEN_REFRESH_MARGIN_SECONDS) * 1000;
  const maxAgeMs = options?.maxAgeMs ?? CODEX_TOKEN_REFRESH_MAX_AGE_MS;
  const now = Date.now();

  const results: CodexTokenRefreshResult[] = [];
  for (const account of readCodexAccountsIndex()) {
    const storedAuthPath = getCodexAccountAuthPath(account.id);
    if (!fs.existsSync(storedAuthPath)) continue;

    let auth: Record<string, any>;
    try {
      auth = readCodexAuthObject(storedAuthPath);
    } catch {
      continue;
    }
    if (!getCodexAuthRefreshToken(auth)) continue;

    const expiry = getCodexAccessTokenExpiry(auth);
    const lastRefresh = getCodexAuthRefreshTime(auth);
    const needsRefresh =
      (typeof expiry === "number" && expiry - now <= marginMs) ||
      now - lastRefresh >= maxAgeMs;
    if (!needsRefresh) continue;

    try {
      await refreshCodexAccountTokens(config, account.id);
      results.push({ id: account.id, label: account.label, refreshed: true });
    } catch (error) {
      results.push({ id: account.id, label: account.label, refreshed: false, error: errorMessage(error) });
    }
  }
  return results;
}

export function activateCodexAccount(
  config: Record<string, any>,
  accountId: string
): CodexAccountOperationResult {
  const accounts = readCodexAccountsIndex();
  const accountIndex = accounts.findIndex((account) => account.id === accountId);
  if (accountIndex < 0) {
    throw new Error(`Unknown Codex account: ${accountId}`);
  }

  const storedAuthPath = getCodexAccountAuthPath(accountId);
  if (!fs.existsSync(storedAuthPath)) {
    throw new Error(`Stored Codex auth file not found: ${storedAuthPath}`);
  }

  const authPath = getCodexAuthPath(config);
  createBackup("codex-auth", authPath);
  writeCodexAuthObject(authPath, readCodexAuthObject(storedAuthPath));

  accounts[accountIndex] = {
    ...accounts[accountIndex],
    lastUsedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeCodexAccountsIndex(accounts);
  setActiveCodexAccountId(config, accountId);

  const result = toCodexAccountsResult(config);
  return {
    ...result,
    success: true,
    account: result.accounts.find((item) => item.id === accountId),
    config,
  };
}

export function deleteCodexAccount(
  config: Record<string, any>,
  accountId: string
): CodexAccountOperationResult {
  const accounts = readCodexAccountsIndex();
  const nextAccounts = accounts.filter((account) => account.id !== accountId);
  if (nextAccounts.length === accounts.length) {
    throw new Error(`Unknown Codex account: ${accountId}`);
  }

  const storedAuthPath = getCodexAccountAuthPath(accountId);
  if (fs.existsSync(storedAuthPath)) {
    fs.unlinkSync(storedAuthPath);
  }

  writeCodexAccountsIndex(nextAccounts);
  if (getActiveCodexAccountId(config) === accountId) {
    setActiveCodexAccountId(config, undefined);
  }

  return {
    ...toCodexAccountsResult(config),
    success: true,
    config,
  };
}

function isCodexManaged(content: string): boolean {
  const provider = getTopLevelTomlValue(content, "model_provider");
  const hasCcrProvider = hasTomlSection(content, "model_providers.ccr");
  return provider === "ccr" || hasCcrProvider;
}

function ensureCodexRouterMapping(config: Record<string, any>, alias: string): void {
  if (!isObject(config.Router)) {
    config.Router = {};
  }
  if (!isObject(config.Router.models)) {
    config.Router.models = {};
  }
  if (!config.Router.models[alias] && typeof config.Router.default === "string" && config.Router.default) {
    config.Router.models[alias] = config.Router.default;
  }
}

// Remove CCR-related keys from the [shell_environment_policy.set] section
function cleanShellEnvVars(content: string): string {
  const ccrEnvKeys = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
  ]);

  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inShellSet = false;

  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (trimmed === "[shell_environment_policy.set]") {
      inShellSet = true;
      output.push(line);
      continue;
    }
    if (inShellSet && /^\[[^\]]+\]$/.test(trimmed)) {
      inShellSet = false;
    }
    if (inShellSet) {
      const kvMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (kvMatch && ccrEnvKeys.has(kvMatch[1])) {
        continue; // skip CCR env vars
      }
    }
    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function createCodexStatus(config: Record<string, any>, content?: string, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "codex");
  const filePath = getResolvedConfigPath(config, "codex");
  const safeContent = content ?? "";
  const model = getTopLevelTomlValue(safeContent, "model");

  return {
    id: "codex",
    name: CLIENT_DEFINITIONS.codex.name,
    enabled: clientConfig.enabled,
    managed: isCodexManaged(safeContent),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: model,
    modelAlias: clientConfig.modelAlias,
    details,
  };
}

const codexAdapter: ClientAdapter = {
  status(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    try {
      return createCodexStatus(config, getCodexContent(filePath));
    } catch (error) {
      return createCodexStatus(config, "", errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    const clientConfig = getClientConfig(config, "codex");
    const alias = clientConfig.modelAlias || CLIENT_DEFINITIONS.codex.defaultConfig.modelAlias;
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("codex", filePath);
    }

    ensureCodexRouterMapping(config, alias);

    let content = getCodexContent(filePath);
    content = removeTomlSection(content, "model_providers.ccr");
    const contextWindow = getContextWindow(config);
    content = setTopLevelTomlValues(content, {
      model: alias,
      model_provider: "ccr",
      // Pin the context window so Codex triggers auto-compaction before the
      // routed (often third-party) model overflows. Codex's built-in catalogue
      // doesn't know the ccr alias and would otherwise fall back to a window
      // that doesn't match the real model, breaking compaction timing.
      model_context_window: contextWindow,
      model_auto_compact_token_limit: Math.floor(contextWindow * 0.9),
    });
    const apiKey = typeof config.APIKEY === "string" ? config.APIKEY : "";
    const authSection = apiKey
      ? `\n\n[model_providers.ccr.http_headers]\nAuthorization = ${quoteTomlString(`Bearer ${apiKey}`)}`
      : "";
    content = `${content.trimEnd()}\n\n[model_providers.ccr]\nname = "Claude Code Router"\nbase_url = "${getCcrBaseUrl(config, "/v1")}"\nwire_api = "responses"${authSection}`;

    writeCodexContent(filePath, content);
    return createCodexStatus(config, content);
  },

  disable(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    if (restoreLatestBackup("codex", filePath)) {
      // Also clean up shell env vars that may have been added outside of CCR
      let content = getCodexContent(filePath);
      content = cleanShellEnvVars(content);
      writeCodexContent(filePath, content);
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }

    const clientConfig = getClientConfig(config, "codex");
    const alias = clientConfig.modelAlias || CLIENT_DEFINITIONS.codex.defaultConfig.modelAlias;
    let content = getCodexContent(filePath);
    const keysToRemove = new Set<string>();

    if (getTopLevelTomlValue(content, "model_provider") === "ccr") {
      keysToRemove.add("model_provider");
      keysToRemove.add("model_context_window");
      keysToRemove.add("model_auto_compact_token_limit");
    }

    const activeModel = getTopLevelTomlValue(content, "model");
    if (activeModel === alias || activeModel?.startsWith("ccr-")) {
      keysToRemove.add("model");
    }

    content = removeTopLevelTomlKeys(content, keysToRemove);
    content = removeTomlSection(content, "model_providers.ccr");
    // Also remove CCR-related shell environment variables
    content = cleanShellEnvVars(content);
    writeCodexContent(filePath, content);
    return createCodexStatus(config, content);
  },

  restore(config) {
    return this.disable(config);
  },
};

// ========================= pi (earendil-works) =========================
//
// pi keeps its config in a directory (~/.pi/agent by default) across three
// JSON files. To route pi through ccr we only touch two of them:
//   - models.json:   register a custom "ccr" provider (Anthropic-compatible,
//                     baseUrl = ccr proxy) with the ccr family-alias models;
//                     the api key lives on the provider entry, so we never
//                     touch auth.json.
//   - settings.json: point defaultProvider/defaultModel at the ccr provider.
// pi speaks the Anthropic /v1/messages protocol (like Claude Code), so no
// transformer is needed on the ccr side.

const PI_PROVIDER_NAME = "ccr";
// pi's Anthropic-messages API id; baseUrl is the root (the SDK appends
// /v1/messages), matching how Claude Code uses ANTHROPIC_BASE_URL.
const PI_ANTHROPIC_API = "anthropic-messages";

interface PiPaths {
  dir: string;
  settings: string;
  models: string;
}

function getPiPaths(config: Record<string, any>): PiPaths {
  const dir = expandHome(getClientConfig(config, "pi").configPath);
  return {
    dir,
    settings: path.join(dir, "settings.json"),
    models: path.join(dir, "models.json"),
  };
}

/**
 * Build the ccr family-alias models pi should expose, mirroring the model
 * family aliases Claude Code takeover uses (ccr-opus/ccr-sonnet/ccr-haiku).
 * Falls back to the configured modelAlias when no families are configured.
 * Returns the model definitions plus the id pi should default to.
 */
function getPiModels(config: Record<string, any>): { models: any[]; defaultModel: string } {
  const contextWindow = getContextWindow(config);
  const makeModel = (id: string, label: string) => ({
    id,
    name: label,
    api: PI_ANTHROPIC_API,
    reasoning: true,
    input: ["text", "image"],
    contextWindow,
    maxTokens: 64000,
  });

  if (hasFamiliesConfig(config)) {
    const families = config.Router.families;
    const order = ["opus", "sonnet", "haiku"].filter((f) => families[f]);
    const models = order.map((family) => {
      const extendedSuffix = hasExtendedContext(families[family]) ? "[1m]" : "";
      return makeModel(`ccr-${family}${extendedSuffix}`, `CCR (${family})`);
    });
    if (models.length > 0) {
      return { models, defaultModel: models[0].id };
    }
  }

  const alias = getClientConfig(config, "pi").modelAlias || "ccr-opus";
  return { models: [makeModel(alias, "CCR")], defaultModel: alias };
}

function isPiProviderManaged(models: Record<string, any>): boolean {
  const provider = isObject(models.providers) ? models.providers[PI_PROVIDER_NAME] : undefined;
  return isObject(provider) && isCcrBaseUrl(provider.baseUrl);
}

function isPiManaged(models: Record<string, any>, settings: Record<string, any>): boolean {
  return isPiProviderManaged(models) || settings.defaultProvider === PI_PROVIDER_NAME;
}

function createPiStatus(
  config: Record<string, any>,
  models?: Record<string, any>,
  settings?: Record<string, any>,
  details?: string
): ClientStatus {
  const clientConfig = getClientConfig(config, "pi");
  const paths = getPiPaths(config);
  const safeModels = models || {};
  const safeSettings = settings || {};

  return {
    id: "pi",
    name: CLIENT_DEFINITIONS.pi.name,
    enabled: clientConfig.enabled,
    managed: isPiManaged(safeModels, safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(paths.dir),
    activeModel:
      typeof safeSettings.defaultModel === "string" ? safeSettings.defaultModel : undefined,
    details,
  };
}

const piAdapter: ClientAdapter = {
  status(config) {
    const paths = getPiPaths(config);
    try {
      return createPiStatus(config, readJsonObject(paths.models), readJsonObject(paths.settings));
    } catch (error) {
      return createPiStatus(config, {}, {}, errorMessage(error));
    }
  },

  enable(config) {
    const paths = getPiPaths(config);
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("pi/models", paths.models);
      createBackup("pi/settings", paths.settings);
    }

    const { defaultModel } = ensurePiCcrProvider(config);
    const models = readJsonObject(paths.models);

    const settings = readJsonObject(paths.settings);
    settings.defaultProvider = PI_PROVIDER_NAME;
    settings.defaultModel = defaultModel;
    writeJsonObject(paths.settings, settings);

    return createPiStatus(config, models, settings);
  },

  disable(config) {
    const paths = getPiPaths(config);

    // models.json: restore the pre-takeover file, or just drop the ccr provider.
    let models: Record<string, any>;
    if (restoreLatestBackup("pi/models", paths.models)) {
      models = readJsonObject(paths.models);
    } else {
      models = readJsonObject(paths.models);
      if (isObject(models.providers) && models.providers[PI_PROVIDER_NAME]) {
        delete models.providers[PI_PROVIDER_NAME];
        writeJsonObject(paths.models, models);
      }
    }

    // settings.json: restore backup, or clear the ccr default selection.
    let settings: Record<string, any>;
    if (restoreLatestBackup("pi/settings", paths.settings)) {
      settings = readJsonObject(paths.settings);
    } else {
      settings = readJsonObject(paths.settings);
      if (settings.defaultProvider === PI_PROVIDER_NAME) {
        delete settings.defaultProvider;
        delete settings.defaultModel;
        writeJsonObject(paths.settings, settings);
      }
    }

    return createPiStatus(config, models, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/**
 * Register (or refresh) the global "ccr" provider in pi's `models.json`.
 *
 * pi has no project-level `models.json` — only `.pi/settings.json` overrides
 * are project-scoped — so the provider definition always lives globally. It is
 * just an *available* provider (baseUrl = ccr proxy); it does not route
 * anything by itself until a settings file points `defaultProvider` at it.
 * Writing it is idempotent, so both the global and project-level pi takeovers
 * call this. Returns the model id callers should set as `defaultModel`.
 */
function ensurePiCcrProvider(config: Record<string, any>): { defaultModel: string } {
  const paths = getPiPaths(config);
  const { models: ccrModels, defaultModel } = getPiModels(config);

  const models = readJsonObject(paths.models);
  if (!isObject(models.providers)) models.providers = {};
  models.providers[PI_PROVIDER_NAME] = {
    name: "Claude Code Router",
    baseUrl: getCcrBaseUrl(config),
    api: PI_ANTHROPIC_API,
    apiKey: config.APIKEY || "test",
    models: ccrModels,
  };
  writeJsonObject(paths.models, models);
  return { defaultModel };
}

/**
 * Path to a project's `.pi/settings.json` (pi's project-scoped settings, which
 * override the global `~/.pi/agent/settings.json`).
 */
function getPiProjectSettingsPath(projectPath: string): string {
  return path.join(projectPath, ".pi", "settings.json");
}

/** Path to pi's global trust ledger (`~/.pi/agent/trust.json`). */
function getPiTrustPath(config: Record<string, any>): string {
  return path.join(getPiPaths(config).dir, "trust.json");
}

/**
 * Mark a project folder as trusted in pi's `trust.json`. pi only loads a
 * project's `.pi/settings.json` (and other project resources) for trusted
 * folders; non-interactive modes (`-p`/json/rpc) never prompt, so without this
 * the takeover's override would be silently ignored there.
 */
function addPiProjectTrust(projectPath: string, config: Record<string, any>): void {
  const trustPath = getPiTrustPath(config);
  const trust = readJsonObject(trustPath);
  if (trust[projectPath] !== true) {
    trust[projectPath] = true;
    writeJsonObject(trustPath, trust);
  }
}

/**
 * Enable ccr takeover for a single project's pi configuration: register the
 * global ccr provider (idempotent), trust the project folder, and point the
 * project's `.pi/settings.json` `defaultProvider`/`defaultModel` at ccr. Other
 * keys in `.pi/settings.json` are preserved.
 */
export function applyPiProjectTakeover(projectPath: string, config: Record<string, any>): void {
  const { defaultModel } = ensurePiCcrProvider(config);
  addPiProjectTrust(projectPath, config);

  const settingsPath = getPiProjectSettingsPath(projectPath);
  const settings = readJsonObject(settingsPath);
  settings.defaultProvider = PI_PROVIDER_NAME;
  settings.defaultModel = defaultModel;
  writeJsonObject(settingsPath, settings);
}

/**
 * Disable ccr takeover for a project's pi configuration by clearing the ccr
 * `defaultProvider`/`defaultModel` from `.pi/settings.json` (removing the file
 * if nothing else remains). The shared global provider definition and trust
 * entry are intentionally left in place, since other projects may rely on them.
 */
export function removePiProjectTakeover(projectPath: string): void {
  const settingsPath = getPiProjectSettingsPath(projectPath);
  if (!fs.existsSync(settingsPath)) return;

  const settings = readJsonObject(settingsPath);
  if (settings.defaultProvider !== PI_PROVIDER_NAME) return;

  delete settings.defaultProvider;
  delete settings.defaultModel;
  if (Object.keys(settings).length === 0) {
    fs.unlinkSync(settingsPath);
  } else {
    writeJsonObject(settingsPath, settings);
  }
}

/** Whether a project's `.pi/settings.json` currently routes pi through ccr. */
export function isPiProjectTakeoverActive(projectPath: string): boolean {
  const settings = readJsonObject(getPiProjectSettingsPath(projectPath));
  return settings.defaultProvider === PI_PROVIDER_NAME;
}

// ========================= qwen-code (Alibaba) =========================
//
// qwen-code (@qwen-code/qwen-code) keeps settings in a single JSON file
// (~/.qwen/settings.json for the user scope, <project>/.qwen/settings.json for
// the workspace scope). The takeover registers a custom Anthropic
// `modelProvider` pointed at the ccr proxy and selects it. qwen speaks the
// Anthropic /v1/messages protocol (like Claude Code / pi), so no transformer is
// needed on the ccr side. The provider's api key lives in `settings.env` and is
// referenced by `envKey`.

const QWEN_PROTOCOL = "anthropic";
const QWEN_ENV_KEY = "QWEN_CCR_API_KEY";

function getQwenSettingsPath(config: Record<string, any>): string {
  return expandHome(getClientConfig(config, "qwenCode").configPath);
}

// qwen stores baseUrl with a trailing slash (matching its own UI output).
function getQwenBaseUrl(config: Record<string, any>): string {
  return `${getCcrBaseUrl(config)}/`;
}

/**
 * Build the ccr family-alias model providers qwen should expose
 * (ccr-opus/ccr-sonnet/ccr-haiku), mirroring the Claude Code / pi takeover.
 * Each entry shares the single env-key holding the ccr api key. Returns the
 * provider entries plus the id qwen should default to.
 */
function getQwenModels(config: Record<string, any>): { providers: any[]; defaultModel: string } {
  const baseUrl = getQwenBaseUrl(config);
  const make = (id: string) => ({ id, name: id, baseUrl, envKey: QWEN_ENV_KEY });

  if (hasFamiliesConfig(config)) {
    const families = config.Router.families;
    const order = ["opus", "sonnet", "haiku"].filter((f) => families[f]);
    const providers = order.map((family) => {
      const extendedSuffix = hasExtendedContext(families[family]) ? "[1m]" : "";
      return make(`ccr-${family}${extendedSuffix}`);
    });
    if (providers.length > 0) {
      return { providers, defaultModel: providers[0].id };
    }
  }

  const alias = getClientConfig(config, "qwenCode").modelAlias || "ccr-opus";
  return { providers: [make(alias)], defaultModel: alias };
}

function isQwenManaged(settings: Record<string, any>): boolean {
  const model = isObject(settings.model) ? settings.model : {};
  if (isCcrBaseUrl(model.baseUrl)) return true;
  const providers = isObject(settings.modelProviders) ? settings.modelProviders[QWEN_PROTOCOL] : undefined;
  return Array.isArray(providers) && providers.some((p) => isObject(p) && isCcrBaseUrl(p.baseUrl));
}

/**
 * Point a qwen `settings.json` object at ccr: write the api key into `env`,
 * register the ccr Anthropic providers (replacing any previous ccr entries
 * while preserving the user's other Anthropic providers), select the Anthropic
 * auth type, and set the active model. Other settings are preserved.
 */
function applyQwenTakeover(settings: Record<string, any>, config: Record<string, any>): void {
  const { providers, defaultModel } = getQwenModels(config);
  const baseUrl = getQwenBaseUrl(config);

  if (!isObject(settings.env)) settings.env = {};
  settings.env[QWEN_ENV_KEY] = config.APIKEY || "test";

  if (!isObject(settings.modelProviders)) settings.modelProviders = {};
  const existing = Array.isArray(settings.modelProviders[QWEN_PROTOCOL])
    ? settings.modelProviders[QWEN_PROTOCOL].filter((p: any) => !(isObject(p) && isCcrBaseUrl(p.baseUrl)))
    : [];
  settings.modelProviders[QWEN_PROTOCOL] = [...existing, ...providers];

  if (!isObject(settings.security)) settings.security = {};
  if (!isObject(settings.security.auth)) settings.security.auth = {};
  settings.security.auth.selectedType = QWEN_PROTOCOL;

  settings.model = { name: defaultModel, baseUrl };
  if (typeof settings.$version !== "number") settings.$version = 4;
}

/**
 * Remove the ccr-managed fields written by {@link applyQwenTakeover}, leaving
 * the user's unrelated settings (and non-ccr Anthropic providers) intact.
 */
function removeQwenManagedFields(settings: Record<string, any>): void {
  if (isObject(settings.env)) {
    delete settings.env[QWEN_ENV_KEY];
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }

  if (isObject(settings.modelProviders) && Array.isArray(settings.modelProviders[QWEN_PROTOCOL])) {
    const remaining = settings.modelProviders[QWEN_PROTOCOL].filter(
      (p: any) => !(isObject(p) && isCcrBaseUrl(p.baseUrl))
    );
    if (remaining.length > 0) {
      settings.modelProviders[QWEN_PROTOCOL] = remaining;
    } else {
      delete settings.modelProviders[QWEN_PROTOCOL];
      if (Object.keys(settings.modelProviders).length === 0) delete settings.modelProviders;
    }
  }

  if (isObject(settings.model) && isCcrBaseUrl(settings.model.baseUrl)) {
    delete settings.model;
  }

  // Clear the Anthropic auth selection we set, but only once no Anthropic
  // providers remain (so a user's own Anthropic provider keeps its selection).
  if (
    isObject(settings.security) &&
    isObject(settings.security.auth) &&
    settings.security.auth.selectedType === QWEN_PROTOCOL
  ) {
    const anthropicProviders = isObject(settings.modelProviders)
      ? settings.modelProviders[QWEN_PROTOCOL]
      : undefined;
    if (!Array.isArray(anthropicProviders) || anthropicProviders.length === 0) {
      delete settings.security.auth.selectedType;
      if (Object.keys(settings.security.auth).length === 0) delete settings.security.auth;
      if (Object.keys(settings.security).length === 0) delete settings.security;
    }
  }
}

function createQwenStatus(config: Record<string, any>, settings?: Record<string, any>, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "qwenCode");
  const filePath = getQwenSettingsPath(config);
  const safeSettings = settings || {};

  return {
    id: "qwenCode",
    name: CLIENT_DEFINITIONS.qwenCode.name,
    enabled: clientConfig.enabled,
    managed: isQwenManaged(safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel:
      isObject(safeSettings.model) && typeof safeSettings.model.name === "string"
        ? safeSettings.model.name
        : undefined,
    details,
  };
}

const qwenCodeAdapter: ClientAdapter = {
  status(config) {
    const filePath = getQwenSettingsPath(config);
    try {
      return createQwenStatus(config, readJsonObject(filePath));
    } catch (error) {
      return createQwenStatus(config, {}, errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getQwenSettingsPath(config);
    if (!this.status(config).managed) {
      createBackup("qwenCode", filePath);
    }
    const settings = readJsonObject(filePath);
    applyQwenTakeover(settings, config);
    writeJsonObject(filePath, settings);
    return createQwenStatus(config, settings);
  },

  disable(config) {
    const filePath = getQwenSettingsPath(config);
    if (restoreLatestBackup("qwenCode", filePath)) {
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }
    const settings = readJsonObject(filePath);
    removeQwenManagedFields(settings);
    writeJsonObject(filePath, settings);
    return createQwenStatus(config, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/** Path to a project's workspace-scoped `.qwen/settings.json`. */
function getQwenProjectSettingsPath(projectPath: string): string {
  return path.join(projectPath, ".qwen", "settings.json");
}

/** Path to qwen's global trust ledger (`~/.qwen/trustedFolders.json`). */
function getQwenTrustPath(config: Record<string, any>): string {
  return path.join(path.dirname(getQwenSettingsPath(config)), "trustedFolders.json");
}

/**
 * Trust a project folder in qwen's `trustedFolders.json`. qwen ignores a
 * workspace's `.qwen/settings.json` unless the folder is trusted, so the
 * project-level takeover must record the trust decision.
 */
function addQwenProjectTrust(projectPath: string, config: Record<string, any>): void {
  const trustPath = getQwenTrustPath(config);
  const trust = readJsonObject(trustPath);
  if (trust[projectPath] !== "TRUST_FOLDER") {
    trust[projectPath] = "TRUST_FOLDER";
    writeJsonObject(trustPath, trust);
  }
}

/**
 * Enable ccr takeover for a project's qwen configuration: trust the folder and
 * write the ccr Anthropic provider/model selection into the project's
 * workspace-scoped `.qwen/settings.json` (self-contained — unlike pi, qwen's
 * workspace settings carry the provider definition too).
 */
export function applyQwenProjectTakeover(projectPath: string, config: Record<string, any>): void {
  addQwenProjectTrust(projectPath, config);
  const settingsPath = getQwenProjectSettingsPath(projectPath);
  const settings = readJsonObject(settingsPath);
  applyQwenTakeover(settings, config);
  writeJsonObject(settingsPath, settings);
}

/**
 * Disable ccr takeover for a project's qwen configuration by removing the
 * ccr-managed fields from its workspace `.qwen/settings.json` (deleting the file
 * when nothing meaningful remains). The global trust entry is left in place.
 */
export function removeQwenProjectTakeover(projectPath: string): void {
  const settingsPath = getQwenProjectSettingsPath(projectPath);
  if (!fs.existsSync(settingsPath)) return;

  const settings = readJsonObject(settingsPath);
  if (!isQwenManaged(settings)) return;

  removeQwenManagedFields(settings);
  // `$version` alone is not meaningful content, so treat it as empty.
  const meaningfulKeys = Object.keys(settings).filter((k) => k !== "$version");
  if (meaningfulKeys.length === 0) {
    fs.unlinkSync(settingsPath);
  } else {
    writeJsonObject(settingsPath, settings);
  }
}

/** Whether a project's `.qwen/settings.json` currently routes qwen through ccr. */
export function isQwenProjectTakeoverActive(projectPath: string): boolean {
  return isQwenManaged(readJsonObject(getQwenProjectSettingsPath(projectPath)));
}

// ========================= opencode (opencode.ai) =========================
//
// opencode keeps its config in a single JSON file (~/.config/opencode/
// opencode.json for the global scope, <project>/opencode.json — merged up to the
// git root — for the project scope). The takeover injects a custom `provider`
// using the Anthropic AI SDK (`@ai-sdk/anthropic`) pointed at the ccr proxy and
// selects it as the default `model`. opencode speaks the Anthropic /v1/messages
// protocol, so no transformer is needed on the ccr side; the api key is inlined
// in the provider's `options`.

const OPENCODE_PROVIDER_ID = "ccr";
const OPENCODE_NPM = "@ai-sdk/anthropic";

function getOpencodeSettingsPath(config: Record<string, any>): string {
  return expandHome(getClientConfig(config, "opencode").configPath);
}

// The @ai-sdk/anthropic SDK appends "/messages" to baseURL, so it must end in
// the ccr "/v1" path (mirroring opencode's own Anthropic provider entries).
function getOpencodeBaseUrl(config: Record<string, any>): string {
  return `${getCcrBaseUrl(config)}/v1`;
}

/**
 * Build the ccr family-alias models opencode should expose
 * (ccr-opus/ccr-sonnet/ccr-haiku). Returns the `models` map plus the
 * "<provider>/<model>" id opencode should default to.
 */
function getOpencodeModels(config: Record<string, any>): { models: Record<string, any>; defaultModel: string } {
  const models: Record<string, any> = {};
  let firstId = "";

  const add = (id: string, label: string) => {
    models[id] = { name: label };
    if (!firstId) firstId = id;
  };

  if (hasFamiliesConfig(config)) {
    const families = config.Router.families;
    for (const family of ["opus", "sonnet", "haiku"].filter((f) => families[f])) {
      const extendedSuffix = hasExtendedContext(families[family]) ? "[1m]" : "";
      add(`ccr-${family}${extendedSuffix}`, `CCR (${family})`);
    }
  }
  if (!firstId) {
    add(getClientConfig(config, "opencode").modelAlias || "ccr-opus", "CCR");
  }

  return { models, defaultModel: `${OPENCODE_PROVIDER_ID}/${firstId}` };
}

function isOpencodeManaged(settings: Record<string, any>): boolean {
  const provider = isObject(settings.provider) ? settings.provider[OPENCODE_PROVIDER_ID] : undefined;
  if (isObject(provider) && isObject(provider.options) && isCcrBaseUrl(provider.options.baseURL)) {
    return true;
  }
  return typeof settings.model === "string" && settings.model.startsWith(`${OPENCODE_PROVIDER_ID}/`);
}

/**
 * Point an opencode config object at ccr: register the ccr Anthropic provider
 * (api key inlined) and select it as the default model. Other settings (the
 * user's own providers, `$schema`, etc.) are preserved.
 */
function applyOpencodeTakeover(settings: Record<string, any>, config: Record<string, any>): void {
  const { models, defaultModel } = getOpencodeModels(config);

  if (!isObject(settings.provider)) settings.provider = {};
  settings.provider[OPENCODE_PROVIDER_ID] = {
    npm: OPENCODE_NPM,
    name: "Claude Code Router",
    options: {
      baseURL: getOpencodeBaseUrl(config),
      apiKey: config.APIKEY || "test",
    },
    models,
  };

  settings.model = defaultModel;
}

/** Remove the ccr-managed fields written by {@link applyOpencodeTakeover}. */
function removeOpencodeManagedFields(settings: Record<string, any>): void {
  if (isObject(settings.provider) && isObject(settings.provider[OPENCODE_PROVIDER_ID])) {
    const provider = settings.provider[OPENCODE_PROVIDER_ID];
    if (isObject(provider.options) && isCcrBaseUrl(provider.options.baseURL)) {
      delete settings.provider[OPENCODE_PROVIDER_ID];
      if (Object.keys(settings.provider).length === 0) delete settings.provider;
    }
  }
  if (typeof settings.model === "string" && settings.model.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
    delete settings.model;
  }
}

function createOpencodeStatus(config: Record<string, any>, settings?: Record<string, any>, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "opencode");
  const filePath = getOpencodeSettingsPath(config);
  const safeSettings = settings || {};

  return {
    id: "opencode",
    name: CLIENT_DEFINITIONS.opencode.name,
    enabled: clientConfig.enabled,
    managed: isOpencodeManaged(safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: typeof safeSettings.model === "string" ? safeSettings.model : undefined,
    details,
  };
}

const opencodeAdapter: ClientAdapter = {
  status(config) {
    const filePath = getOpencodeSettingsPath(config);
    try {
      return createOpencodeStatus(config, readJsonObject(filePath));
    } catch (error) {
      return createOpencodeStatus(config, {}, errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getOpencodeSettingsPath(config);
    if (!this.status(config).managed) {
      createBackup("opencode", filePath);
    }
    const settings = readJsonObject(filePath);
    applyOpencodeTakeover(settings, config);
    writeJsonObject(filePath, settings);
    return createOpencodeStatus(config, settings);
  },

  disable(config) {
    const filePath = getOpencodeSettingsPath(config);
    if (restoreLatestBackup("opencode", filePath)) {
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }
    const settings = readJsonObject(filePath);
    removeOpencodeManagedFields(settings);
    writeJsonObject(filePath, settings);
    return createOpencodeStatus(config, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/** Path to a project's project-scoped `opencode.json` (merged up to the git root). */
function getOpencodeProjectSettingsPath(projectPath: string): string {
  return path.join(projectPath, "opencode.json");
}

/**
 * Enable ccr takeover for a project's opencode configuration by writing the ccr
 * Anthropic provider/model into the project's `opencode.json`. opencode has no
 * trust gate, so nothing else is needed.
 */
export function applyOpencodeProjectTakeover(projectPath: string, config: Record<string, any>): void {
  const settingsPath = getOpencodeProjectSettingsPath(projectPath);
  const settings = readJsonObject(settingsPath);
  if (typeof settings.$schema !== "string") settings.$schema = "https://opencode.ai/config.json";
  applyOpencodeTakeover(settings, config);
  writeJsonObject(settingsPath, settings);
}

/**
 * Disable ccr takeover for a project's opencode configuration by removing the
 * ccr-managed fields from its `opencode.json` (deleting the file when nothing
 * meaningful remains).
 */
export function removeOpencodeProjectTakeover(projectPath: string): void {
  const settingsPath = getOpencodeProjectSettingsPath(projectPath);
  if (!fs.existsSync(settingsPath)) return;

  const settings = readJsonObject(settingsPath);
  if (!isOpencodeManaged(settings)) return;

  removeOpencodeManagedFields(settings);
  // `$schema` alone is not meaningful content, so treat it as empty.
  const meaningfulKeys = Object.keys(settings).filter((k) => k !== "$schema");
  if (meaningfulKeys.length === 0) {
    fs.unlinkSync(settingsPath);
  } else {
    writeJsonObject(settingsPath, settings);
  }
}

/** Whether a project's `opencode.json` currently routes opencode through ccr. */
export function isOpencodeProjectTakeoverActive(projectPath: string): boolean {
  return isOpencodeManaged(readJsonObject(getOpencodeProjectSettingsPath(projectPath)));
}

/**
 * Clients that support *project-level* ccr takeover (writing a project-scoped
 * config file). Claude Code uses `.claude/settings.local.json`; pi uses
 * `.pi/settings.json`; qwen-code uses `.qwen/settings.json`; opencode uses
 * `opencode.json`. Codex is intentionally excluded — its config
 * (`~/.codex/config.toml`) is global-only, so it can only be taken over from the
 * Clients page, not per project.
 */
export const PROJECT_TAKEOVER_CLIENT_IDS: ClientId[] = ["claudeCode", "pi", "qwenCode", "opencode"];

/** Type guard for {@link PROJECT_TAKEOVER_CLIENT_IDS}. */
export function isProjectTakeoverClient(value: string): value is ClientId {
  return (PROJECT_TAKEOVER_CLIENT_IDS as string[]).includes(value);
}

const CLIENT_ADAPTERS: Record<ClientId, ClientAdapter> = {
  claudeCode: claudeCodeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
  qwenCode: qwenCodeAdapter,
  opencode: opencodeAdapter,
};

export function listClientStatuses(config: Record<string, any>): ClientStatus[] {
  return CLIENT_IDS.map((id) => CLIENT_ADAPTERS[id].status(config));
}

function runClientOperation(
  config: Record<string, any>,
  id: ClientId,
  action: ClientAction,
  options: ClientOperationOptions = {}
): ClientOperationResult {
  const updateEnabled = options.updateEnabled !== false;
  const adapter = CLIENT_ADAPTERS[id];
  const status = adapter[action](config);
  const patch: Partial<ClientConfig> = {
    managed: action === "enable",
    configPath: status.configPath,
  };

  if (status.modelAlias) {
    patch.modelAlias = status.modelAlias;
  }

  if (updateEnabled) {
    patch.enabled = action === "enable";
  } else {
    patch.enabled = getClientConfig(config, id).enabled;
  }

  setClientConfig(config, id, patch);
  const updatedStatus = adapter.status(config);

  return {
    id,
    action,
    success: true,
    status: updatedStatus,
  };
}

export function enableClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "enable", options);
}

export function disableClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "disable", options);
}

export function restoreClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "restore", options);
}

export function applyClientSelection(
  config: Record<string, any>,
  enabledIds: string[]
): ClientApplyResult {
  const selected = new Set(enabledIds);
  const results: ClientOperationResult[] = [];

  for (const id of selected) {
    if (!isClientId(id)) {
      results.push({
        id: id as ClientId,
        action: "enable",
        success: false,
        error: `Unknown client: ${id}`,
      });
    }
  }

  for (const id of CLIENT_IDS) {
    try {
      results.push(
        selected.has(id)
          ? enableClient(config, id, { updateEnabled: true })
          : disableClient(config, id, { updateEnabled: true })
      );
    } catch (error) {
      results.push({
        id,
        action: selected.has(id) ? "enable" : "disable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}

export function enableConfiguredClients(config: Record<string, any>): ClientApplyResult {
  const results: ClientOperationResult[] = [];

  for (const id of CLIENT_IDS) {
    if (!isClientEnabled(config, id)) continue;

    try {
      results.push(enableClient(config, id, { updateEnabled: false }));
    } catch (error) {
      results.push({
        id,
        action: "enable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}

export function disableConfiguredClients(config: Record<string, any>): ClientApplyResult {
  const results: ClientOperationResult[] = [];

  for (const id of CLIENT_IDS) {
    if (!isClientEnabled(config, id)) continue;

    try {
      results.push(disableClient(config, id, { updateEnabled: false }));
    } catch (error) {
      results.push({
        id,
        action: "disable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}
