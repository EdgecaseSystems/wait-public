import { describe, expect, it } from "vitest";
import { MAX_WAIT_SECONDS, MIN_WAIT_SECONDS } from "../src/validation";
import { listWaitOffers, publicOfferCatalog, selectWaitOffer } from "../src/offers";

describe("wait offer catalog", () => {
  it("keeps the MVP event-driven rather than polling-frequency priced", () => {
    const catalog = publicOfferCatalog();
    expect(catalog).toMatchObject({
      pricing_basis: "per_wait",
      event_driven: true,
      polling_frequency: null,
    });
  });

  it("currently prices every supported timeout through one flat 24-hour offer", () => {
    const shortest = selectWaitOffer(MIN_WAIT_SECONDS);
    const longest = selectWaitOffer(MAX_WAIT_SECONDS);
    expect(shortest.offer_id).toBe("event-24h-v1");
    expect(longest.offer_id).toBe(shortest.offer_id);
    expect(shortest.price_usd).toBe("0.01");
    expect(shortest.event_limit).toBe(1);
    expect(shortest.polling_interval_seconds).toBeNull();
  });

  it("keeps pricing rules in a catalog so future duration tiers do not require a request-schema change", () => {
    const offers = listWaitOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0]?.min_timeout_seconds).toBe(MIN_WAIT_SECONDS);
    expect(offers[0]?.max_timeout_seconds).toBe(MAX_WAIT_SECONDS);
  });

  it("refuses to quote unsupported durations", () => {
    expect(() => selectWaitOffer(MIN_WAIT_SECONDS - 1)).toThrow(RangeError);
    expect(() => selectWaitOffer(MAX_WAIT_SECONDS + 1)).toThrow(RangeError);
    expect(() => selectWaitOffer(90.5)).toThrow(RangeError);
  });
});
