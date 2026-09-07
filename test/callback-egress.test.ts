import { describe, expect, it } from "vitest";
import { validateCallbackUrl, MAX_CALLBACK_URL_LENGTH } from "../src/validation";

describe("public callback URL contract", () => {
  it.each(["https://agent.example.com/callback", "https://arbitrary.buyer.example.org:443/callback"])("accepts %s without host registration", (url) => {
    expect(validateCallbackUrl(url)).toBe(new URL(url).toString());
  });
  it("preserves the URL length limit", () => {
    expect(() => validateCallbackUrl("https://agent.example.com/" + "x".repeat(MAX_CALLBACK_URL_LENGTH))).toThrow();
  });
});
