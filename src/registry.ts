import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import { API_VERSION, type AgentName, AgentNameSchema } from "./contracts.js";
import { GatewayError } from "./errors.js";

export type AgentSupport = "verified" | "reserved";

export interface AdapterDefinition {
  agent: AgentName;
  support: AgentSupport;
  command: string;
  args: string[];
  installHint: string;
  env?: NodeJS.ProcessEnv;
  sandboxWritablePaths?: string[];
}

export interface ResolvedAdapter extends AdapterDefinition {
  executable: string;
  fingerprint: string;
}

export interface DoctorAgentResult {
  agent: AgentName;
  support: AgentSupport;
  available: boolean;
  executable?: string;
  installHint: string;
}

const BUILT_IN_ADAPTERS: Record<AgentName, AdapterDefinition> = {
  opencode: {
    agent: "opencode",
    support: "verified",
    command: "opencode",
    args: ["acp"],
    installHint: "Install OpenCode and ensure `opencode` is available on PATH.",
    sandboxWritablePaths: [
      join(homedir(), ".cache", "opencode"),
      join(homedir(), ".config", "opencode"),
      join(homedir(), ".local", "share", "opencode"),
      join(homedir(), ".local", "state", "opencode"),
    ],
  },
  claude: {
    agent: "claude",
    support: "verified",
    command: "claude-agent-acp",
    args: [],
    installHint:
      "Install @agentclientprotocol/claude-agent-acp and ensure `claude-agent-acp` is available on PATH.",
    sandboxWritablePaths: [join(homedir(), ".claude")],
  },
  codex: {
    agent: "codex",
    support: "verified",
    command: "codex-acp",
    args: [],
    installHint:
      "Install @zed-industries/codex-acp and ensure `codex-acp` is available on PATH.",
    sandboxWritablePaths: [join(homedir(), ".codex")],
  },
};

function loadDefinitions(): Record<AgentName, AdapterDefinition> {
  const fakeCommand = process.env.ACP_AGENT_GATEWAY_FAKE_ADAPTER;
  if (!fakeCommand) {
    return BUILT_IN_ADAPTERS;
  }
  const segments = fakeCommand.split(" ");
  const command = segments[0];
  const args = segments.slice(1);
  if (!command) {
    return BUILT_IN_ADAPTERS;
  }
  return {
    ...BUILT_IN_ADAPTERS,
    opencode: {
      ...BUILT_IN_ADAPTERS.opencode,
      command,
      args,
    },
  };
}

export class AgentRegistry {
  readonly #definitions: Record<AgentName, AdapterDefinition>;

  constructor(
    definitions: Record<AgentName, AdapterDefinition> = loadDefinitions(),
  ) {
    this.#definitions = definitions;
  }

  definition(agent: string): AdapterDefinition {
    const parsed = AgentNameSchema.safeParse(agent);
    if (!parsed.success) {
      throw new GatewayError(
        "unsupported_agent",
        `Unsupported agent: ${agent}`,
      );
    }
    return this.#definitions[parsed.data];
  }

  async resolve(agent: string): Promise<ResolvedAdapter> {
    const definition = this.definition(agent);
    if (definition.support !== "verified") {
      throw new GatewayError(
        "unsupported_agent",
        `Agent is reserved but not verified: ${definition.agent}`,
      );
    }
    const executable = await findExecutableOnPath(definition.command);
    if (!executable) {
      throw new GatewayError(
        "adapter_not_found",
        `Adapter executable was not found on PATH: ${definition.command}`,
      );
    }
    return {
      ...definition,
      executable,
      fingerprint: fingerprint({
        apiVersion: API_VERSION,
        agent: definition.agent,
        executable,
        args: definition.args,
        sandboxWritablePaths: definition.sandboxWritablePaths,
      }),
    };
  }

  async doctor(): Promise<DoctorAgentResult[]> {
    return Promise.all(
      Object.values(this.#definitions).map(async (definition) => {
        const executable = await findExecutableOnPath(definition.command);
        return {
          agent: definition.agent,
          support: definition.support,
          available: executable !== undefined,
          ...(executable ? { executable } : {}),
          installHint: definition.installHint,
        };
      }),
    );
  }
}

export async function findExecutableOnPath(
  command: string,
): Promise<string | undefined> {
  const candidates = executableCandidates(command);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue looking through PATH.
    }
  }
  return undefined;
}

function executableCandidates(command: string): string[] {
  const path = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  return path
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => join(directory, `${command}${extension}`)),
    );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
