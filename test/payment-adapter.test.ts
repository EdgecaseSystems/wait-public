import { describe, expect, it } from "vitest";
import {
  MockPaymentAdapter,
  InMemoryMockPaymentProvider,
  createMockPaymentSignature,
  decodePaymentHeader,
  encodePaymentHeader,
  makePaymentRequired,
} from "../src/payment-adapter";

const secret = new Uint8Array(32).fill(34);
const binding = {
  resource: "https://wait.example/v1/waits",
  offerId: "event-24h-v1",
  requestFingerprint: "ab".repeat(32),
};

describe("offline mock x402 adapter", () => {
  it("produces canonical stateless negotiation requirements", () => {
    const requirement = makePaymentRequired(binding);
    expect(decodePaymentHeader(encodePaymentHeader(requirement))).toEqual(requirement);
    expect(requirement).toMatchObject({ x402Version: 2, resource: { url: binding.resource } });
  });

  it("binds an accepted proof to resource, offer, and canonical request", async () => {
    const signature = await createMockPaymentSignature(secret, binding, {
      payer: "mock-payer",
      nonce: "bcc3a6aa-d49d-44fc-8d72-0cd92f1fdf35",
      outcome: "accepted",
    });
    const adapter = new MockPaymentAdapter(secret);
    const authorization = await adapter.authorize(signature, binding);
    expect(authorization.proofFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    await expect(adapter.attemptAcceptance(authorization, "wait-payment-test-operation")).resolves.toMatchObject({
      outcome: "accepted",
      payerIdentity: "mock-payer",
    });
    await expect(adapter.authorize(signature, { ...binding, resource: "https://other.example/v1/waits" }))
      .rejects.toMatchObject({ code: "payment_binding_mismatch" });
  });

  it("rejects tampered proofs before an adapter attempt", async () => {
    const signature = await createMockPaymentSignature(secret, binding, {
      payer: "mock-payer",
      nonce: "bcc3a6aa-d49d-44fc-8d72-0cd92f1fdf35",
      outcome: "accepted",
    });
    const tampered = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    await expect(new MockPaymentAdapter(secret).authorize(tampered, binding))
      .rejects.toMatchObject({ code: "invalid_payment_proof" });
  });

  it("never rebinds one deterministic external operation to a different payment proof", async () => {
    const provider = new InMemoryMockPaymentProvider();
    const adapter = new MockPaymentAdapter(secret, provider);
    const firstSignature = await createMockPaymentSignature(secret, binding, {
      payer: "mock-payer",
      nonce: "bcc3a6aa-d49d-44fc-8d72-0cd92f1fdf35",
      outcome: "accepted",
    });
    const secondSignature = await createMockPaymentSignature(secret, binding, {
      payer: "mock-payer",
      nonce: "841d532c-a262-4a6d-9e52-ed79c4faee8a",
      outcome: "accepted",
    });
    const first = await adapter.authorize(firstSignature, binding);
    const second = await adapter.authorize(secondSignature, binding);
    const operationId = "wait-payment-4ae3a657-402c-41c4-885a-9dc12a455fea";
    await expect(adapter.attemptAcceptance(first, operationId)).resolves.toMatchObject({ outcome: "accepted" });
    await expect(adapter.reconcileAcceptance(second, operationId)).resolves.toEqual({
      outcome: "unknown",
      failureCode: "mock_operation_binding_conflict",
    });
    await expect(adapter.attemptAcceptance(second, operationId)).resolves.toEqual({
      outcome: "ambiguous",
      failureCode: "mock_operation_binding_conflict",
    });
  });
});
