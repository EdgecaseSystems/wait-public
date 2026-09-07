import { reportIncident } from "./monitoring";
import { deriveCapability, hashCapability } from "./capabilities";
import { resolveCapabilityKey, selectCapabilityKey } from "./capability-keys";
import { LifecycleError } from "./errors";
import { errorResponse, jsonResponse } from "./http";
import { fingerprintCreateWaitRequest, hashIdempotencyKey, readPaidIdempotencyKey } from "./idempotency";
import { selectWaitOffer } from "./offers";
import { openApiDocument } from "./openapi";
import {
  MockPaymentAdapter,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  paymentExternalOperationId,
  paymentResponse,
  type PaymentAdapter,
  type PaymentAttemptResult,
  type PaymentBinding,
} from "./payment-adapter";
import { X402BaseSepoliaPaymentAdapter } from "./x402-payment-adapter";
import {
  acceptFirstEvent,
  activateWait,
  authorizePaymentAttempt,
  cancelWaitingWait,
  commitAcceptedPayment,
  commitAmbiguousPaymentAndHonor,
  commitUnacceptedPayment,
  createProvisioningWait,
  ensurePaymentRow,
  getCommercialCapacity,
  getPaymentByProofFingerprint,
  getPaymentRow,
  getRequestById,
  getRequestByIdempotencyKeyHash,
  getServiceControls,
  getWaitByRequestId,
  getWaitByStatusTokenHash,
  markExternalPaymentCallStarted,
  recordPaymentReconciliation,
  recoverObservedCallbackSuccess,
  reserveCommercialAdmission,
  reserveRequest,
  transitionRequestState,
  expireWaitingWait,
  type IdempotentRequestRow,
  type WaitRow,
} from "./repository";
import { IDEMPOTENCY_REPLAY_RETENTION_MS } from "./retention";
import { toPublicWaitStatus } from "./state";
import type { JsonValue, WaitStatusResponse } from "./types";
import { parseCreateWaitRequest, parseEventJson } from "./validation";
import { reconstructCreateWaitResponse } from "./wait-response";
import { provisionDeliveryWorkflow as createDeliveryWorkflow } from "./delivery-provisioning";

export interface RouteDependencies {
  paymentAdapter?: PaymentAdapter;
  now?: () => Date;
  afterPaymentAccepted?: () => void;
  afterCommercialAdmission?: () => void | Promise<void>;
  afterSettlementAuthorized?: () => void;
  afterExternalCallStarted?: () => void;
  afterExternalAcceptance?: () => void;
  afterAmbiguityHonored?: () => void;
}

function unavailable(message: string): Response {
  return jsonResponse({ error: "service_unavailable", message, retryable: false }, 503);
}

function rejectedPaymentResponse(paymentRequiredHeader: string): Response {
  return jsonResponse(
    { error: "payment_rejected", message: "The payment was rejected.", retryable: false },
    402,
    { [PAYMENT_REQUIRED_HEADER]: paymentRequiredHeader },
  );
}

function secretFromHex(value: string | undefined, name: string): Uint8Array {
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${name}_unavailable`);
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function configuredOrigin(env: Env, request: Request): string {
  if (!env.PUBLIC_ORIGIN) throw new Error("public_origin_unavailable");
  const configured = new URL(env.PUBLIC_ORIGIN);
  if (configured.protocol !== "https:" || configured.origin !== env.PUBLIC_ORIGIN || new URL(request.url).origin !== configured.origin) {
    throw new Error("public_origin_mismatch");
  }
  return configured.origin;
}

function defaultPaymentAdapter(env: Env): PaymentAdapter {
  if (env.PAYMENT_MODE === "mock") {
    return new MockPaymentAdapter(secretFromHex(env.MOCK_PAYMENT_KEY, "mock_payment_key"));
  }
  if (env.PAYMENT_MODE === "x402-base-sepolia" || env.PAYMENT_MODE === "x402-base-mainnet") {
    return new X402BaseSepoliaPaymentAdapter(env);
  }
  throw new Error("payment_adapter_unavailable");
}

async function assertCommercialAdmission(env: Env, now: Date): Promise<void> {
  const controls = await getServiceControls(env.DB);
  if (controls.new_sales_enabled !== 1) throw new Error("new_sales_disabled");
  const capacity = await getCommercialCapacity(env.DB, now);
  if (capacity.active_waits >= controls.max_active_waits || capacity.paid_waits_today >= controls.max_paid_waits_per_day) {
    throw new LifecycleError("commercial_capacity_reached", "Commercial capacity is currently exhausted.", true, 60);
  }
}

async function reconstruct(row: WaitRow, env: Env) {
  return reconstructCreateWaitResponse(row, (version) => resolveCapabilityKey(env, version));
}

async function finishEntitlement(
  env: Env,
  requestRow: IdempotentRequestRow,
  input: Awaited<ReturnType<typeof parseCreateWaitRequest>>,
  now: Date,
): Promise<WaitRow> {
  let lifecycle = await getRequestById(env.DB, requestRow.request_id);
  if (!lifecycle) throw new LifecycleError("idempotency_state_ambiguous", "Entitlement lifecycle disappeared during recovery.");
  const payment = await getPaymentRow(env.DB, requestRow.request_id);
  const isEntitled = payment?.state === "accepted" ||
    (payment?.state === "ambiguous" && payment.ambiguity_honored_at !== null);
  if (!isEntitled) throw new LifecycleError("idempotency_state_ambiguous", "Wait entitlement lacks a durable payment disposition.");

  let wait = await getWaitByRequestId(env.DB, requestRow.request_id);
  if (!wait) {
    if (lifecycle.state === "payment_accepted") {
      try {
        await transitionRequestState(env.DB, lifecycle.request_id, "payment_accepted", "provisioning", now);
      } catch {
        // A concurrent recovery may have won. The reload below is authoritative.
      }
      lifecycle = await getRequestById(env.DB, lifecycle.request_id);
    }
    if (lifecycle?.state !== "provisioning") {
      throw new LifecycleError("idempotency_state_ambiguous", "Payment disposition cannot prove a repairable provisioning state.");
    }

    const waitId = lifecycle.request_id;
    const { key, version } = selectCapabilityKey(env);
    const [eventToken, statusToken] = await Promise.all([
      deriveCapability(key, waitId, "event"),
      deriveCapability(key, waitId, "status"),
    ]);
    const createdAt = payment.state === "accepted" ? payment.accepted_at : payment.ambiguity_honored_at;
    if (createdAt === null) {
      throw new LifecycleError("idempotency_state_ambiguous", "Entitlement payment disposition lacks its resolution time.");
    }
    const expiresAt = new Date(new Date(createdAt).getTime() + input.timeout_seconds * 1_000).toISOString();
    try {
      await createProvisioningWait(env.DB, {
        waitId,
        requestId: lifecycle.request_id,
        publicOrigin: configuredOrigin(env, new Request(`${env.PUBLIC_ORIGIN}/v1/waits`)),
        callbackUrl: input.callback_url,
        clientReference: input.client_reference ?? null,
        capabilityKeyVersion: version,
        eventTokenHash: await hashCapability(eventToken),
        statusTokenHash: await hashCapability(statusToken),
        createdAt,
        expiresAt,
      });
    } catch {
      // The unique request/wait row may already have been created concurrently.
    }
    wait = await getWaitByRequestId(env.DB, lifecycle.request_id);
  }

  if (!wait) throw new LifecycleError("idempotency_state_ambiguous", "Payment disposition has no recoverable wait entitlement.");
  if (wait.state === "provisioning") {
    try {
      await activateWait(env.DB, wait.wait_id, now);
    } catch {
      // A concurrent recovery may have activated it.
    }
    wait = await getWaitByRequestId(env.DB, requestRow.request_id);
  }
  if (!wait || !["waiting", "event_received", "delivering", "delivered", "delivery_failed", "expired", "cancelled"].includes(wait.state)) {
    throw new LifecycleError("idempotency_state_ambiguous", "Paid wait entitlement is not safely replayable.");
  }

  lifecycle = await getRequestById(env.DB, requestRow.request_id);
  if (lifecycle?.state === "provisioning") {
    try {
      await transitionRequestState(env.DB, lifecycle.request_id, "provisioning", "fulfilled", now);
    } catch {
      // A concurrent recovery may have fulfilled it.
    }
  }
  const finalLifecycle = await getRequestById(env.DB, requestRow.request_id);
  if (finalLifecycle?.state !== "fulfilled") {
    throw new LifecycleError("idempotency_state_ambiguous", "Paid wait fulfillment could not be proven.");
  }
  return wait;
}

async function handleCreateWait(request: Request, env: Env, dependencies: RouteDependencies): Promise<Response> {
  const origin = configuredOrigin(env, request);
  const input = await parseCreateWaitRequest(request);
  const now = dependencies.now?.() ?? new Date();
  const offer = selectWaitOffer(input.timeout_seconds);
  const requestFingerprint = await fingerprintCreateWaitRequest(input);
  const binding: PaymentBinding = {
    resource: `${origin}/v1/waits`,
    offerId: offer.offer_id,
    requestFingerprint,
  };
  const adapter = dependencies.paymentAdapter ?? defaultPaymentAdapter(env);
  const requirements = adapter.paymentRequired(binding);
  const paymentRequiredHeader = adapter.encodePaymentRequired(requirements);
  const signature = request.headers.get(PAYMENT_SIGNATURE_HEADER);

  if (signature === null) {
    await assertCommercialAdmission(env, now);
    return jsonResponse(
      { error: "payment_required", message: "Retry with PAYMENT-SIGNATURE and a UUIDv4 Idempotency-Key." },
      402,
      { [PAYMENT_REQUIRED_HEADER]: paymentRequiredHeader },
    );
  }

  const idempotencyKey = readPaidIdempotencyKey(request);
  const idempotencyHash = await hashIdempotencyKey(idempotencyKey);
  const preexistingRequest = await getRequestByIdempotencyKeyHash(env.DB, idempotencyHash);
  if (preexistingRequest?.request_fingerprint !== undefined && preexistingRequest.request_fingerprint !== requestFingerprint) {
    throw new LifecycleError("idempotency_key_conflict", "The Idempotency-Key is already bound to a different logical request.");
  }
  const preexistingPayment = preexistingRequest === null
    ? null
    : await getPaymentRow(env.DB, preexistingRequest.request_id);
  if (preexistingPayment?.state === "rejected") return rejectedPaymentResponse(paymentRequiredHeader);

  const authorization = await adapter.authorize(signature, binding);
  const replayExpiresAt = new Date(now.getTime() + IDEMPOTENCY_REPLAY_RETENTION_MS).toISOString();
  const existingProof = await getPaymentByProofFingerprint(env.DB, authorization.proofFingerprint);

  const reservation = await reserveRequest(env.DB, idempotencyHash, requestFingerprint, now, replayExpiresAt);
  const requestRow = reservation.kind === "acquired"
    ? await getRequestById(env.DB, reservation.requestId)
    : reservation.row;
  if (!requestRow) throw new LifecycleError("idempotency_state_ambiguous", "Idempotency reservation could not be recovered.");

  let payment = preexistingRequest?.request_id === requestRow.request_id
    ? preexistingPayment
    : await getPaymentRow(env.DB, requestRow.request_id);
  if (existingProof && existingProof.request_id !== requestRow.request_id) {
    throw new LifecycleError("payment_proof_conflict", "Payment proof is already bound to another logical purchase.");
  }
  if (payment?.payment_proof_fingerprint && payment.payment_proof_fingerprint !== authorization.proofFingerprint) {
    throw new LifecycleError("payment_proof_conflict", "The logical purchase is bound to a different payment proof.");
  }

  if (payment?.state === "accepted" || (payment?.state === "ambiguous" && payment.ambiguity_honored_at !== null)) {
    const wait = await finishEntitlement(env, requestRow, input, now);
    return jsonResponse(
      await reconstruct(wait, env),
      201,
      payment.state === "accepted" ? {
        [PAYMENT_RESPONSE_HEADER]: adapter.encodePaymentResponse(paymentResponse({
          success: true,
          transaction: payment.transaction_id ?? undefined,
          network: payment.network ?? undefined,
        })),
      } : undefined,
    );
  }
  if (payment?.state === "rejected") return rejectedPaymentResponse(paymentRequiredHeader);
  if (payment?.state === "ambiguous" || requestRow.state === "ambiguous") {
    throw new LifecycleError("payment_ambiguous", "Payment lifecycle is not safe to retry automatically.");
  }

  if (!payment) {
    payment = await ensurePaymentRow(env.DB, requestRow.request_id, now);
  }
  if (payment.state === "reserved") {
    if (requestRow.state !== "reserved") {
      throw new LifecycleError("idempotency_state_ambiguous", "Payment reservation is not uniquely claimable.");
    }
    const admission = await reserveCommercialAdmission(env.DB, requestRow.request_id, now);
    if (admission.state !== "reserved" || admission.counts_daily !== 1 || admission.active_held !== 1) {
      throw new LifecycleError("idempotency_state_ambiguous", "Commercial admission is not durably reserved.");
    }
    await dependencies.afterCommercialAdmission?.();
    try {
      await authorizePaymentAttempt(env.DB, requestRow.request_id, {
        network: authorization.network,
        asset: authorization.asset,
        amount: authorization.amount,
        payTo: authorization.payTo,
        paymentProofFingerprint: authorization.proofFingerprint,
        externalOperationId: paymentExternalOperationId(requestRow.request_id),
      }, now);
    } catch (error) {
      const conflict = await getPaymentByProofFingerprint(env.DB, authorization.proofFingerprint);
      if (conflict && conflict.request_id !== requestRow.request_id) {
        throw new LifecycleError("payment_proof_conflict", "Payment proof is already bound to another logical purchase.");
      }
      throw error;
    }
    dependencies.afterSettlementAuthorized?.();
    payment = await getPaymentRow(env.DB, requestRow.request_id);
  }
  if (
    payment?.state !== "settling" || !payment.external_operation_id ||
    payment.payment_proof_fingerprint !== authorization.proofFingerprint
  ) {
    throw new LifecycleError("idempotency_state_ambiguous", "Settling payment cannot prove its deterministic external operation.");
  }

  let attempt: PaymentAttemptResult | undefined;
  if (payment.external_call_started_at !== null) {
    const reconciled = await adapter.reconcileAcceptance(authorization, payment.external_operation_id);
    await recordPaymentReconciliation(env.DB, requestRow.request_id, reconciled.outcome, now);
    if (reconciled.outcome === "accepted" || reconciled.outcome === "rejected") {
      attempt = reconciled;
    } else if (reconciled.outcome === "unknown") {
      await commitAmbiguousPaymentAndHonor(env.DB, requestRow.request_id, reconciled.failureCode, now);
      dependencies.afterAmbiguityHonored?.();
      const honoredRequest = await getRequestById(env.DB, requestRow.request_id);
      if (!honoredRequest) throw new LifecycleError("idempotency_state_ambiguous", "Honored ambiguity could not be recovered.");
      const wait = await finishEntitlement(env, honoredRequest, input, now);
      return jsonResponse(await reconstruct(wait, env), 201);
    }
  }
  if (!attempt) {
    if (payment.external_call_started_at === null) {
      await markExternalPaymentCallStarted(env.DB, requestRow.request_id, now);
      dependencies.afterExternalCallStarted?.();
    }
    try {
      attempt = await adapter.attemptAcceptance(authorization, payment.external_operation_id);
    } catch {
      const reconciled = await adapter.reconcileAcceptance(authorization, payment.external_operation_id);
      await recordPaymentReconciliation(env.DB, requestRow.request_id, reconciled.outcome, now);
      attempt = reconciled.outcome === "accepted" || reconciled.outcome === "rejected"
        ? reconciled
        : { outcome: "ambiguous", failureCode: reconciled.outcome === "unknown" ? reconciled.failureCode : "payment_call_result_unproven" };
    }
  }
  if (attempt.outcome !== "accepted") {
    if (attempt.outcome === "rejected") {
      await commitUnacceptedPayment(env.DB, requestRow.request_id, "rejected", attempt.failureCode, now);
      return rejectedPaymentResponse(paymentRequiredHeader);
    }
    await commitAmbiguousPaymentAndHonor(env.DB, requestRow.request_id, attempt.failureCode, now);
    dependencies.afterAmbiguityHonored?.();
    const honoredRequest = await getRequestById(env.DB, requestRow.request_id);
    if (!honoredRequest) throw new LifecycleError("idempotency_state_ambiguous", "Honored ambiguity could not be recovered.");
    const wait = await finishEntitlement(env, honoredRequest, input, now);
    return jsonResponse(await reconstruct(wait, env), 201);
  }

  dependencies.afterExternalAcceptance?.();
  await commitAcceptedPayment(env.DB, requestRow.request_id, {
    network: authorization.network,
    asset: authorization.asset,
    amount: authorization.amount,
    payTo: authorization.payTo,
    paymentProofFingerprint: authorization.proofFingerprint,
    payerIdentity: attempt.payerIdentity,
    transactionId: attempt.transactionId,
  }, now);
  dependencies.afterPaymentAccepted?.();
  const acceptedRequest = await getRequestById(env.DB, requestRow.request_id);
  if (!acceptedRequest) throw new LifecycleError("idempotency_state_ambiguous", "Accepted request could not be recovered.");
  const wait = await finishEntitlement(env, acceptedRequest, input, now);
  return jsonResponse(await reconstruct(wait, env), 201, {
    [PAYMENT_RESPONSE_HEADER]: adapter.encodePaymentResponse(paymentResponse({
      success: true,
      transaction: attempt.transactionId,
      network: authorization.network,
    })),
  });
}

function eventCapability(pathname: string): string | null {
  const match = /^\/e\/([0-9a-f]{64})$/u.exec(pathname);
  return match?.[1] ?? null;
}

function statusCapability(pathname: string): { capability: string; cancel: boolean } | null {
  const match = /^\/s\/([0-9a-f]{64})(\/cancel)?$/u.exec(pathname);
  return match ? { capability: match[1], cancel: match[2] === "/cancel" } : null;
}

async function handleEvent(request: Request, env: Env, capability: string, dependencies: RouteDependencies): Promise<Response> {
  if (!env.DELIVERY_WORKFLOW) return unavailable("Delivery configuration is unavailable.");
  const event = await parseEventJson(request) as JsonValue;
  const now = dependencies.now?.() ?? new Date();
  const accepted = await acceptFirstEvent(env.DB, await hashCapability(capability), event, now);
  if (accepted.kind === "not_found") return jsonResponse({ error: "not_found", retryable: false }, 404);
  if (accepted.kind === "different_event_conflict" || accepted.kind === "not_waiting") {
    return jsonResponse({ error: "event_conflict", retryable: false }, 409);
  }
  if (
    accepted.kind === "accepted" ||
    (accepted.kind === "same_event_retry" && ["event_received", "delivering"].includes(accepted.state))
  ) {
    try {
      if (
        accepted.kind === "same_event_retry" && accepted.state === "delivering" &&
        await recoverObservedCallbackSuccess(env.DB, accepted.waitId, accepted.deliveryWorkflowInstanceId, now)
      ) {
        return jsonResponse({ accepted: true, wait_id: accepted.waitId }, 202);
      }
      await createDeliveryWorkflow(
        env.DELIVERY_WORKFLOW,
        accepted.waitId,
        accepted.deliveryWorkflowInstanceId,
        accepted.kind === "same_event_retry",
      );
    } catch {
      return jsonResponse({ error: "delivery_provisioning_unproven", retryable: true }, 503);
    }
  }
  return jsonResponse({ accepted: true, wait_id: accepted.waitId }, 202);
}

async function readStatusRow(env: Env, capability: string, now: Date): Promise<WaitRow | null> {
  const hash = await hashCapability(capability);
  let row = await getWaitByStatusTokenHash(env.DB, hash);
  if (row?.state === "waiting" && row.expires_at <= now.toISOString()) {
    await expireWaitingWait(env.DB, row.wait_id, now);
    row = await getWaitByStatusTokenHash(env.DB, hash);
  }
  return row;
}

function statusResponse(row: WaitRow): WaitStatusResponse {
  return {
    wait_id: row.wait_id,
    status: toPublicWaitStatus(row.state),
    client_reference: row.client_reference,
    created_at: row.created_at,
    expires_at: row.expires_at,
    event_received_at: row.event_received_at,
    callback_delivered_at: row.callback_delivered_at,
    callback_attempts: row.callback_attempts,
    ...(row.event_json === null ? {} : { event: JSON.parse(row.event_json) as JsonValue }),
  };
}

async function handleStatus(
  request: Request,
  env: Env,
  route: { capability: string; cancel: boolean },
  dependencies: RouteDependencies,
): Promise<Response> {
  const now = dependencies.now?.() ?? new Date();
  if (route.cancel) {
    if (request.method !== "POST") return jsonResponse({ error: "not_found" }, 404);
    const result = await cancelWaitingWait(env.DB, await hashCapability(route.capability), now);
    if (result.kind === "not_found") return jsonResponse({ error: "not_found", retryable: false }, 404);
    const row = await readStatusRow(env, route.capability, now);
    if (!row) return jsonResponse({ error: "not_found", retryable: false }, 404);
    if (result.kind === "not_cancellable" && result.state !== "cancelled") {
      return jsonResponse({ error: "not_cancellable", status: toPublicWaitStatus(result.state), retryable: false }, 409);
    }
    return jsonResponse(statusResponse(row));
  }
  if (request.method !== "GET") return jsonResponse({ error: "not_found" }, 404);
  const row = await readStatusRow(env, route.capability, now);
  return row ? jsonResponse(statusResponse(row)) : jsonResponse({ error: "not_found", retryable: false }, 404);
}

export async function handleProductRoute(
  request: Request,
  env: Env | undefined,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  if (!env?.DB) return unavailable("Required service configuration is unavailable.");
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/v1/waits") return await handleCreateWait(request, env, dependencies);
    const event = eventCapability(url.pathname);
    if (request.method === "POST" && event) return await handleEvent(request, env, event, dependencies);
    const status = statusCapability(url.pathname);
    if (status) return await handleStatus(request, env, status, dependencies);
    return jsonResponse({ error: "not_found", retryable: false }, 404);
  } catch (error) {
    if (error instanceof Error && [
      "new_sales_disabled",
      "public_origin_unavailable",
      "public_origin_mismatch",
      "payment_adapter_unavailable",
      "mock_payment_key_unavailable",
      "capability_key_unavailable",
    ].includes(error.message)) return unavailable("Required service configuration is unavailable.");
    const response = errorResponse(error);
    if (response.status >= 500) reportIncident("worker_error", "fetch");
    return response;
  }
}
