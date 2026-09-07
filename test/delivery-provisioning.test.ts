import { describe, expect, it, vi } from "vitest";
import {
  provisionDeliveryWorkflow,
  type DeliveryWorkflowBinding,
} from "../src/delivery-provisioning";

function binding(status: InstanceStatus["status"]) {
  const restart = vi.fn(async () => undefined);
  const createBatch = vi.fn(async () => []);
  const workflow: DeliveryWorkflowBinding = {
    get: vi.fn(async (id: string) => ({
      id,
      status: async () => ({ status, rollback: null }),
      restart,
    })),
    createBatch,
  };
  return { workflow, restart, createBatch };
}

describe("delivery Workflow reconciliation", () => {
  it.each(["errored", "terminated"] as const)("restarts one %s deterministic instance", async (status) => {
    const { workflow, restart, createBatch } = binding(status);
    await expect(provisionDeliveryWorkflow(workflow, "wait-1", "delivery-wait-1", true)).resolves.toBe("restarted");
    expect(restart).toHaveBeenCalledOnce();
    expect(createBatch).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "paused", "waiting", "waitingForPause", "complete"] as const)(
    "does not duplicate an existing %s instance",
    async (status) => {
      const { workflow, restart, createBatch } = binding(status);
      await expect(provisionDeliveryWorkflow(workflow, "wait-2", "delivery-wait-2", true)).resolves.toBe("existing");
      expect(restart).not.toHaveBeenCalled();
      expect(createBatch).not.toHaveBeenCalled();
    },
  );
});
