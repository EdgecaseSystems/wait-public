import { LifecycleError } from "./errors";
import type { IdempotentRequestState, PaymentState, PublicWaitStatus, WaitState } from "./types";

const WAIT_TRANSITIONS: Readonly<Record<WaitState, readonly WaitState[]>> = {
  provisioning: ["waiting", "provisioning_failed_paid", "ambiguous"],
  waiting: ["event_received", "expired", "cancelled", "ambiguous"],
  event_received: ["delivering", "ambiguous"],
  delivering: ["delivered", "delivery_failed", "ambiguous"],
  delivered: [],
  delivery_failed: [],
  expired: [],
  cancelled: [],
  provisioning_failed_paid: [],
  ambiguous: [],
};

const PAYMENT_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  reserved: ["settling"],
  settling: ["accepted", "rejected", "ambiguous"],
  accepted: [],
  rejected: [],
  ambiguous: [],
};

const REQUEST_TRANSITIONS: Readonly<Record<IdempotentRequestState, readonly IdempotentRequestState[]>> = {
  reserved: ["settling"],
  settling: ["payment_accepted", "ambiguous"],
  ambiguous: [],
  payment_accepted: ["provisioning"],
  provisioning: ["fulfilled", "provisioning_failed_paid", "ambiguous"],
  provisioning_failed_paid: [],
  fulfilled: [],
};

export function canTransitionWait(from: WaitState, to: WaitState): boolean {
  return WAIT_TRANSITIONS[from].includes(to);
}

export function assertWaitTransition(from: WaitState, to: WaitState): void {
  if (!canTransitionWait(from, to)) {
    throw new LifecycleError("illegal_wait_transition", `Illegal wait transition: ${from} -> ${to}.`);
  }
}

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransitionPayment(from, to)) {
    throw new LifecycleError("illegal_payment_transition", `Illegal payment transition: ${from} -> ${to}.`);
  }
}

export function canTransitionRequest(from: IdempotentRequestState, to: IdempotentRequestState): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function assertRequestTransition(from: IdempotentRequestState, to: IdempotentRequestState): void {
  if (!canTransitionRequest(from, to)) {
    throw new LifecycleError("illegal_request_transition", `Illegal request transition: ${from} -> ${to}.`);
  }
}

export function toPublicWaitStatus(state: WaitState): PublicWaitStatus {
  if (state === "provisioning" || state === "provisioning_failed_paid" || state === "ambiguous") {
    return "service_attention_required";
  }
  return state;
}

export function isTerminalWaitState(state: WaitState): boolean {
  return WAIT_TRANSITIONS[state].length === 0;
}
