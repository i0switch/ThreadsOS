import { describe, expect, it } from "vitest";
import { assertSafePublicUrl } from "../src/utils/network-policy.js";

describe("network-policy", () => {
  it("accepts safe public https urls", () => {
    const parsed = assertSafePublicUrl("https://note.com/example/n/post-1", {
      allowSubdomainsOf: ["note.com"],
      requireHttps: true,
    });

    expect(parsed.hostname).toBe("note.com");
  });

  it("rejects localhost and private ip targets", () => {
    expect(() => assertSafePublicUrl("http://127.0.0.1:3000/admin")).toThrow();
    expect(() => assertSafePublicUrl("http://192.168.1.2/")).toThrow(
      "Blocked hostname",
    );
  });

  it("rejects hosts outside allowlisted domains", () => {
    expect(() =>
      assertSafePublicUrl("https://example.com/post", {
        allowSubdomainsOf: ["note.com"],
      }),
    ).toThrow("Host is outside allowed domains");
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      assertSafePublicUrl("https://user:pass@note.com/private"),
    ).toThrow("Credentials in URL are not allowed");
  });

  it("rejects custom ports", () => {
    expect(() => assertSafePublicUrl("https://note.com:8443/private")).toThrow(
      "Custom ports are not allowed",
    );
  });
});
