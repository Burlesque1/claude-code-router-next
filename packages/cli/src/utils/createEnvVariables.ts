import { readConfigFile } from ".";

const CLAUDE_AUTO_COMPACT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "85",
};

function hasExtendedContext(familyConfig: any): boolean {
  return familyConfig?.enableExtendedContext === true;
}

/**
 * Inject model family env vars when families are configured in CCR.
 * This ensures `ccr code` uses the correct ccr-* model names for routing,
 * regardless of what's in ~/.claude/settings.json.
 */
function getModelEnvVars(config: any): Record<string, string | undefined> {
  const families = config?.Router?.families;
  if (!families || typeof families !== "object") return {};

  const familyNames = Object.keys(families);
  if (familyNames.length === 0) return {};

  const env: Record<string, string | undefined> = {};
  let primaryFamily: string | null = null;

  for (const family of familyNames) {
    const familyConfig = families[family];
    const extendedSuffix = hasExtendedContext(familyConfig) ? "[1m]" : "";
    const ccrModel = `ccr-${family}${extendedSuffix}`;

    switch (family) {
      case "opus":
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "opus";
        break;
      case "sonnet":
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "sonnet";
        break;
      case "haiku":
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "haiku";
        break;
    }
  }

  if (primaryFamily) {
    // Default to opus, fallback to first configured family
    const defaultFamily = families["opus"] ? "opus" : primaryFamily;
    const defaultConfig = families[defaultFamily];
    const extendedSuffix = hasExtendedContext(defaultConfig) ? "[1m]" : "";
    env.ANTHROPIC_MODEL = `ccr-${defaultFamily}${extendedSuffix}`;

    const thinkFamily = familyNames.find((f: string) => families[f]?.think);
    if (thinkFamily) {
      const thinkConfig = families[thinkFamily];
      const thinkExtendedSuffix = hasExtendedContext(thinkConfig) ? "[1m]" : "";
      env.ANTHROPIC_REASONING_MODEL = `ccr-${thinkFamily}${thinkExtendedSuffix}`;
    } else {
      env.ANTHROPIC_REASONING_MODEL = `ccr-${defaultFamily}${extendedSuffix}`;
    }
  }

  return env;
}

/**
 * Get environment variables for Agent SDK/Claude Code integration
 * This function is shared between `ccr env` and `ccr code` commands
 */
export const createEnvVariables = async (): Promise<Record<string, string | undefined>> => {
  const config = await readConfigFile();
  const port = config.PORT || 3456;
  const apiKey = config.APIKEY || "test";

  return {
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    NO_PROXY: "127.0.0.1",
    DISABLE_TELEMETRY: "true",
    DISABLE_COST_WARNINGS: "true",
    API_TIMEOUT_MS: String(config.API_TIMEOUT_MS ?? 600000),
    // Strip the dynamic attribution header (client version + prompt fingerprint)
    // from the start of the system prompt. It changes between requests and breaks
    // the upstream prompt-cache prefix when routing through CCR (an LLM gateway).
    // Enabled by default; users can opt out via `disableAttributionHeader: false`.
    CLAUDE_CODE_ATTRIBUTION_HEADER:
      config.disableAttributionHeader === false ? undefined : "0",
    ...CLAUDE_AUTO_COMPACT_ENV,
    // Reset CLAUDE_CODE_USE_BEDROCK when running with ccr
    CLAUDE_CODE_USE_BEDROCK: undefined,
    ...getModelEnvVars(config),
  };
}
