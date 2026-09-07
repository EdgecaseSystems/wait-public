/** Illustrative directory metadata for a sanitized portfolio snapshot. */
export const directoryDiscovery = {
  name: "CDP Bazaar",
  search_url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=wait.example.com&limit=20",
  resource: "https://wait.example.com/v1/waits",
  last_verified_at: null,
  verification: "Illustrative portfolio metadata only. This example resource has not been verified or listed in a public directory.",
} as const;


const publicOrigin = new URL(directoryDiscovery.resource).origin;
export const apiCatalog = {
  linkset: [
    { anchor: publicOrigin + "/.well-known/api-catalog", item: [{ href: publicOrigin + "/", type: "application/json", title: "Edgecase Wait - temporary durable event capture, callback retries, and recovery" }] },
    { anchor: publicOrigin + "/", "service-desc": [{ href: publicOrigin + "/openapi.json", type: "application/json" }] },
  ],
} as const;
export const catalogHeaders = {
  "content-type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  "cache-control": "no-store",
  link: '</.well-known/api-catalog>; rel="api-catalog"',
};
