import { beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => ({
  backend: {
    id: "secret-service",
    name: "Linux Secret Service",
    priority: 10,
  } as { id: string; name: string; priority: number },
  deletePassword: vi.fn(),
  getKeyring: vi.fn(),
  getPassword: vi.fn(),
  initBackend: vi.fn(),
  setPassword: vi.fn(),
}));

vi.mock("cross-keychain", () => ({
  deletePassword: keychain.deletePassword,
  getKeyring: keychain.getKeyring,
  getPassword: keychain.getPassword,
  initBackend: keychain.initBackend,
  setPassword: keychain.setPassword,
}));

import { NativeCredentialStore } from "./credentials.js";

const apiUrl = "https://kbdrop.io";
const credential = {
  version: 1 as const,
  apiUrl,
  accessToken: `kb_oauth_at_${"a".repeat(12)}_${"b".repeat(43)}`,
  accessExpiresAt: "2026-08-22T15:15:00.000Z",
  refreshToken: `kb_oauth_rt_${"c".repeat(12)}_${"d".repeat(43)}`,
  scope: "knowledge:read knowledge:query offline_access",
  account: { email: "agent@example.com" },
};

describe("native OAuth credential storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keychain.backend.id = "secret-service";
    keychain.backend.name = "Linux Secret Service";
    keychain.getKeyring.mockResolvedValue(keychain.backend);
    keychain.getPassword.mockResolvedValue(null);
    keychain.setPassword.mockResolvedValue(undefined);
    keychain.deletePassword.mockResolvedValue(undefined);
    keychain.initBackend.mockImplementation(async (
      limit?: (backend: typeof keychain.backend) => boolean,
    ) => {
      if (!limit?.(keychain.backend)) throw new Error("backend rejected");
    });
  });

  it("rejects file/null fallback backends instead of persisting plaintext", async () => {
    keychain.backend.id = "file";
    keychain.backend.name = "File backend";
    await expect(new NativeCredentialStore().get(apiUrl)).rejects.toMatchObject({
      kind: "auth",
      code: "keychain_unavailable",
    });
    expect(keychain.getPassword).not.toHaveBeenCalled();
  });

  it("maps native read, write, and delete failures without exposing values", async () => {
    keychain.getPassword.mockRejectedValueOnce(new Error("private read detail"));
    await expect(new NativeCredentialStore().get(apiUrl)).rejects.toMatchObject({
      code: "keychain_read_failed",
      message: expect.not.stringContaining("private read detail"),
    });

    keychain.setPassword.mockRejectedValueOnce(new Error("private write detail"));
    await expect(
      new NativeCredentialStore().set(apiUrl, credential),
    ).rejects.toMatchObject({
      code: "keychain_write_failed",
      message: expect.not.stringContaining(credential.accessToken),
    });

    keychain.getPassword.mockResolvedValueOnce(JSON.stringify(credential));
    keychain.deletePassword.mockRejectedValueOnce(
      new Error("private delete detail"),
    );
    await expect(new NativeCredentialStore().delete(apiUrl)).rejects.toMatchObject({
      code: "keychain_delete_failed",
      message: expect.not.stringContaining(credential.refreshToken),
    });
  });
});
