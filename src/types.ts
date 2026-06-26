import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";

export const SDK_VERSION = "0.1.0";

export interface SteadwingConfig {
  apiKey: string;
  service?: string;
  env?: string;
  enabled?: boolean;
}

export interface RuntimeInfo {
  node_version: string;
  os: string;
  hostname: string;
  container_id: string | null;
  git_sha: string | null;
}

export interface BaseEvent {
  type: string;
  service: string;
  env: string;
  timestamp: number;
  sdk_version: string;
  runtime: RuntimeInfo;
  [key: string]: unknown;
}

export interface Breadcrumb {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface StackFrame {
  filename: string;
  lineno: number;
  colno?: number;
  function: string;
  locals?: Record<string, string>;
}

export interface ExceptionEvent {
  exception_type: string;
  exception_message: string;
  traceback: string;
  frames: StackFrame[];
  exception_chain: Array<{ type: string; message: string }>;
  breadcrumbs: Breadcrumb[];
  request_context?: Record<string, unknown>;
  count?: number;
}

export interface LogEvent {
  message: string;
  level: string;
  timestamp: number;
  pathname?: string;
  lineno?: number;
  module?: string;
}

function getGitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { timeout: 5000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getContainerId(): string | null {
  try {
    const content = fs.readFileSync("/proc/self/cgroup", "utf8");
    for (const line of content.split("\n")) {
      const parts = line.trim().split("/");
      if (parts.length > 2 && parts[parts.length - 1].length === 64) {
        return parts[parts.length - 1].substring(0, 12);
      }
    }
  } catch {
    // Not in a container or can't read cgroup
  }
  return null;
}

export function buildRuntimeInfo(): RuntimeInfo {
  return {
    node_version: process.version,
    os: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    container_id: getContainerId(),
    git_sha: getGitSha(),
  };
}

export function baseEvent(
  type: string,
  service: string,
  env: string,
  runtime: RuntimeInfo
): BaseEvent {
  return {
    type,
    service,
    env,
    timestamp: Date.now() / 1000,
    sdk_version: SDK_VERSION,
    runtime,
  };
}
