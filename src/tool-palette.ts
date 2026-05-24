import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

export interface ToolPalette {
  readonly registeredToolNames: readonly string[];
  readonly activeToolNames: readonly string[];
  readonly hasProcess: boolean;
  readonly hasCodeSearch: boolean;
  readonly hasNativeFind: boolean;
  readonly hasNativeGrep: boolean;
  readonly hasNativeRead: boolean;
  readonly hasRg: boolean;
  readonly hasFd: boolean;
  readonly hasTmux: boolean;
}

export const EMPTY_TOOL_PALETTE: ToolPalette = {
  registeredToolNames: [],
  activeToolNames: [],
  hasProcess: false,
  hasCodeSearch: false,
  hasNativeFind: false,
  hasNativeGrep: false,
  hasNativeRead: false,
  hasRg: false,
  hasFd: false,
  hasTmux: false,
};

export async function detectToolPalette(pi: ExtensionAPI): Promise<ToolPalette> {
  const registeredToolNames = getRegisteredToolNames(pi);
  const activeToolNames = getActiveToolNames(pi);
  const active = new Set(activeToolNames);

  const [hasRg, hasFd, hasTmux] = await Promise.all([
    commandExists(pi, "rg"),
    commandExists(pi, "fd").then(async (found) => found || (await commandExists(pi, "fdfind"))),
    commandExists(pi, "tmux"),
  ]);

  return {
    registeredToolNames,
    activeToolNames,
    hasProcess: active.has("process"),
    hasCodeSearch: active.has("code_search"),
    hasNativeFind: active.has("find"),
    hasNativeGrep: active.has("grep"),
    hasNativeRead: active.has("read"),
    hasRg,
    hasFd,
    hasTmux,
  };
}

function getRegisteredToolNames(pi: ExtensionAPI): string[] {
  try {
    return pi.getAllTools().map((tool: ToolInfo) => tool.name).sort();
  } catch {
    return [];
  }
}

function getActiveToolNames(pi: ExtensionAPI): string[] {
  try {
    return [...pi.getActiveTools()].sort();
  } catch {
    return [];
  }
}

async function commandExists(pi: ExtensionAPI, command: string): Promise<boolean> {
  try {
    const result = await pi.exec("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
      timeout: 500,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}
