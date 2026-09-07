import { pathToFileURL } from "node:url";
export const WAIT_RESOURCE = "https://wait.example.com/v1/waits";
export const DIRECTORY_SEARCH = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=wait.example.com&limit=20";
export function checkDirectoryResult(body) {
  const match = body?.resources?.find(item => item.resource === WAIT_RESOURCE);
  if (!match) throw new Error("Exact Wait resource not present in directory search; absence from this result does not prove global delisting.");
  if (match.extensions?.bazaar?.info?.input?.method !== "POST" || !match.extensions?.bazaar?.schema) {
    throw new Error("Wait directory entry is missing its POST discovery contract.");
  }
  return { resource: match.resource, method: "POST", directory: "CDP Bazaar", checked_at: new Date().toISOString() };
}
export async function checkDiscovery(fetcher = fetch) {
  const response = await fetcher(DIRECTORY_SEARCH, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Directory lookup failed with HTTP " + response.status);
  return checkDirectoryResult(await response.json());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkDiscovery(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
