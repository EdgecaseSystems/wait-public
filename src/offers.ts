import { MAX_WAIT_SECONDS, MIN_WAIT_SECONDS } from "./validation";

export const WAIT_OFFER_CATALOG_VERSION = "2026-09-01.1";

/**
 * One commercial rule for the event-driven wait product.
 *
 * The API deliberately selects an offer from timeout_seconds rather than making
 * the caller understand a separate pricing endpoint. This lets us add duration
 * tiers later without changing the create-wait request shape.
 */
export interface WaitOffer {
  offer_id: string;
  capability: "wait_for_event";
  price_usd: string;
  min_timeout_seconds: number;
  max_timeout_seconds: number;
  event_limit: 1;
  polling_interval_seconds: null;
}

const WAIT_OFFERS: readonly WaitOffer[] = Object.freeze([
  Object.freeze({
    offer_id: "event-24h-v1",
    capability: "wait_for_event" as const,
    price_usd: "0.01",
    min_timeout_seconds: MIN_WAIT_SECONDS,
    max_timeout_seconds: MAX_WAIT_SECONDS,
    event_limit: 1 as const,
    polling_interval_seconds: null,
  }),
]);

export function listWaitOffers(): readonly WaitOffer[] {
  return WAIT_OFFERS;
}

export function selectWaitOffer(timeoutSeconds: number): WaitOffer {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < MIN_WAIT_SECONDS || timeoutSeconds > MAX_WAIT_SECONDS) {
    throw new RangeError(`timeoutSeconds must be an integer from ${MIN_WAIT_SECONDS} through ${MAX_WAIT_SECONDS}.`);
  }

  const offer = WAIT_OFFERS.find(
    (candidate) => timeoutSeconds >= candidate.min_timeout_seconds && timeoutSeconds <= candidate.max_timeout_seconds,
  );
  if (!offer) throw new RangeError("No active Edgecase Wait offer covers the requested timeout.");
  return offer;
}

export function publicOfferCatalog(): Record<string, unknown> {
  return {
    catalog_version: WAIT_OFFER_CATALOG_VERSION,
    pricing_basis: "per_wait",
    event_driven: true,
    polling_frequency: null,
    offers: WAIT_OFFERS.map((offer) => ({ ...offer })),
  };
}
