import { createHash } from "node:crypto";
import {
  deletePassword,
  getKeyring,
  getPassword,
  initBackend,
  setPassword,
} from "cross-keychain";
import { CliError } from "./errors.js";
import type { OAuthCredential } from "./types.js";

const NATIVE_BACKENDS = new Set([
  "native-macos",
  "macos",
  "windows",
  "secret-service",
]);
const ACCOUNT = "oauth";
const ACCESS_TOKEN_PATTERN =
  /^kb_oauth_at_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u;
const REFRESH_TOKEN_PATTERN =
  /^kb_oauth_rt_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u;

export interface CredentialStore {
  get(apiUrl: string): Promise<OAuthCredential | null>;
  set(apiUrl: string, credential: OAuthCredential): Promise<void>;
  delete(apiUrl: string): Promise<void>;
  backendName?(): Promise<string>;
}

function service(apiUrl: string): string {
  const digest = createHash("sha256").update(apiUrl).digest("hex").slice(0, 24);
  return `io.kbdrop.cli.${digest}`;
}

function validCredential(value: unknown, apiUrl: string): value is OAuthCredential {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const account = record.account as Record<string, unknown> | undefined;
  return (
    record.version === 1 &&
    record.apiUrl === apiUrl &&
    typeof record.accessToken === "string" &&
    ACCESS_TOKEN_PATTERN.test(record.accessToken) &&
    typeof record.accessExpiresAt === "string" &&
    !Number.isNaN(Date.parse(record.accessExpiresAt)) &&
    (record.refreshToken === null ||
      (typeof record.refreshToken === "string" &&
        REFRESH_TOKEN_PATTERN.test(record.refreshToken))) &&
    typeof record.scope === "string" &&
    typeof account?.email === "string"
  );
}

export class NativeCredentialStore implements CredentialStore {
  private initialized = false;

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await initBackend((backend) => NATIVE_BACKENDS.has(backend.id));
      const backend = await getKeyring();
      if (!NATIVE_BACKENDS.has(backend.id)) {
        throw new Error("No native keychain backend is available.");
      }
      this.initialized = true;
    } catch {
      throw new CliError(
        "auth",
        "keychain_unavailable",
        "No native OS credential store is available. Configure Keychain, Credential Manager, or Secret Service and try again.",
      );
    }
  }

  async backendName(): Promise<string> {
    await this.initialize();
    return (await getKeyring()).name;
  }

  async get(apiUrl: string): Promise<OAuthCredential | null> {
    await this.initialize();
    let encoded: string | null;
    try {
      encoded = await getPassword(service(apiUrl), ACCOUNT);
    } catch {
      throw new CliError(
        "auth",
        "keychain_read_failed",
        "The saved kbDrop login could not be read from the OS credential store.",
      );
    }
    if (!encoded) return null;
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (validCredential(parsed, apiUrl)) return parsed;
    } catch {
      // The generic error below deliberately avoids including credential data.
    }
    throw new CliError(
      "auth",
      "saved_login_invalid",
      "The saved kbDrop login is invalid. Run `kb-drop auth logout`, then log in again.",
    );
  }

  async set(apiUrl: string, credential: OAuthCredential): Promise<void> {
    await this.initialize();
    try {
      await setPassword(service(apiUrl), ACCOUNT, JSON.stringify(credential));
    } catch {
      throw new CliError(
        "auth",
        "keychain_write_failed",
        "The kbDrop login could not be saved in the OS credential store.",
      );
    }
  }

  async delete(apiUrl: string): Promise<void> {
    await this.initialize();
    try {
      if (await getPassword(service(apiUrl), ACCOUNT)) {
        await deletePassword(service(apiUrl), ACCOUNT);
      }
    } catch {
      throw new CliError(
        "auth",
        "keychain_delete_failed",
        "The saved kbDrop login could not be removed from the OS credential store.",
      );
    }
  }
}
