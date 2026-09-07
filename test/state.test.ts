import { describe, expect, it } from "vitest";
import {
  assertPaymentTransition,
  assertRequestTransition,
  assertWaitTransition,
  canTransitionWait,
  isTerminalWaitState,
  toPublicWaitStatus,
} from "../src/state";

describe("wait lifecycle", () => {
  it("allows the intended happy path", () => {
    expect(canTransitionWait("provisioning", "waiting")).toBe(true);
    expect(canTransitionWait("waiting", "event_received")).toBe(true);
    expect(canTransitionWait("event_received", "delivering")).toBe(true);
    expect(canTransitionWait("delivering", "delivered")).toBe(true);
  });

  it("I-043/I-044 terminal expired and cancelled waits cannot revive", () => {
    expect(canTransitionWait("expired", "event_received")).toBe(false);
    expect(canTransitionWait("cancelled", "event_received")).toBe(false);
    expect(() => assertWaitTransition("expired", "event_received")).toThrowError(/Illegal wait transition/u);
    expect(() => assertWaitTransition("cancelled", "event_received")).toThrowError(/Illegal wait transition/u);
  });

  it("does not allow an accepted event to be erased by cancellation", () => {
    expect(canTransitionWait("event_received", "cancelled")).toBe(false);
  });

  it("maps unresolved internal states conservatively", () => {
    expect(toPublicWaitStatus("provisioning")).toBe("service_attention_required");
    expect(toPublicWaitStatus("provisioning_failed_paid")).toBe("service_attention_required");
    expect(toPublicWaitStatus("ambiguous")).toBe("service_attention_required");
    expect(toPublicWaitStatus("waiting")).toBe("waiting");
  });

  it("recognizes terminal wait states", () => {
    for (const state of ["delivered", "delivery_failed", "expired", "cancelled", "provisioning_failed_paid", "ambiguous"] as const) {
      expect(isTerminalWaitState(state)).toBe(true);
    }
    expect(isTerminalWaitState("waiting")).toBe(false);
  });
});

describe("commercial lifecycles", () => {
  it("payment can cross settlement only from reserved", () => {
    expect(() => assertPaymentTransition("reserved", "settling")).not.toThrow();
    expect(() => assertPaymentTransition("settling", "accepted")).not.toThrow();
    expect(() => assertPaymentTransition("accepted", "settling")).toThrowError(/Illegal payment transition/u);
  });

  it("request lifecycle separates payment acceptance from provisioning and fulfillment", () => {
    expect(() => assertRequestTransition("reserved", "settling")).not.toThrow();
    expect(() => assertRequestTransition("settling", "payment_accepted")).not.toThrow();
    expect(() => assertRequestTransition("payment_accepted", "provisioning")).not.toThrow();
    expect(() => assertRequestTransition("provisioning", "fulfilled")).not.toThrow();
    expect(() => assertRequestTransition("fulfilled", "settling")).toThrowError(/Illegal request transition/u);
  });
});
