import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { openApiDocument } from "../src/openapi";
import { checkDirectoryResult, WAIT_RESOURCE } from "../scripts/check-discovery.mjs";
describe("external directory discovery", () => {
  it("links matching illustrative directory metadata from root and OpenAPI", async () => {
    const body = await (await handleRequest(new Request("https://wait.example/"))).json();
    expect(body.discovery.global_listing).toBe(false);
    expect(body.discovery.directory.last_verified_at).toBeNull();
    expect(body.discovery.directory).toEqual(openApiDocument["x-directory-discovery"]);
    expect(openApiDocument["x-directory-discovery"].resource).toBe(WAIT_RESOURCE);
    expect(openApiDocument["x-directory-discovery"].verification).toContain("Illustrative portfolio metadata only");
  });
  it("requires the exact resource and POST metadata rather than a similar search result", () => {
    const entry = { resource: WAIT_RESOURCE, extensions: { bazaar: { info: { input: { method: "POST" } }, schema: {} } } };
    expect(checkDirectoryResult({ resources: [entry] }).resource).toBe(WAIT_RESOURCE);
    expect(() => checkDirectoryResult({ resources: [{ ...entry, resource: WAIT_RESOURCE + "/fake" }] })).toThrow("Exact Wait resource");
    expect(() => checkDirectoryResult({ resources: [{ resource: WAIT_RESOURCE }] })).toThrow("POST discovery contract");
  });
});


it("serves the RFC 9727 catalog via GET and HEAD without bindings or bearer URLs", async () => {
  const get = await handleRequest(new Request("https://wait.example/.well-known/api-catalog"));
  expect(get.headers.get("content-type")).toContain("application/linkset+json");
  expect(get.headers.get("content-type")).toContain("rfc9727");
  const body = await get.json();
  expect(body.linkset[0].item[0].href).toBe("https://wait.example.com/");
  expect(body.linkset[1]["service-desc"][0].href).toBe("https://wait.example.com/openapi.json");
  expect(JSON.stringify(body)).not.toMatch(/\/(?:e|s)\//u);
  const head = await handleRequest(new Request("https://wait.example/.well-known/api-catalog", { method: "HEAD" }));
  expect(await head.text()).toBe("");
  expect(head.headers.get("link")).toContain('rel="api-catalog"');
  for (const path of ["/", "/openapi.json"]) expect((await handleRequest(new Request("https://wait.example" + path))).headers.get("link")).toBe(head.headers.get("link"));
});
