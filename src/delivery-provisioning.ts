import { LifecycleError } from "./errors";
import { deliveryWorkflowInstanceId } from "./repository";
import { WORKFLOW_INSTANCE_RETENTION } from "./retention";

export type DeliveryProvisioningResult = "provisioned" | "existing" | "restarted";

export interface DeliveryWorkflowBinding {
  get(id: string): Promise<Pick<WorkflowInstance, "id" | "status" | "restart">>;
  createBatch(
    options: WorkflowInstanceCreateOptions<DeliveryWorkflowParams>[],
  ): Promise<Array<Pick<WorkflowInstance, "id">>>;
}

export async function provisionDeliveryWorkflow(
  workflow: DeliveryWorkflowBinding,
  waitId: string,
  intendedInstanceId: string,
  reconcileExisting = false,
): Promise<DeliveryProvisioningResult> {
  const expected = deliveryWorkflowInstanceId(waitId);
  if (intendedInstanceId !== expected) {
    throw new LifecycleError("idempotency_state_ambiguous", "Refusing to provision a non-deterministic delivery Workflow identity.");
  }
  if (reconcileExisting) {
    const existing = await workflow.get(intendedInstanceId);
    if (existing.id !== intendedInstanceId) {
      throw new LifecycleError("idempotency_state_ambiguous", "Workflow lookup returned an unexpected instance identity.");
    }
    const status = await existing.status();
    if (status.status === "errored" || status.status === "terminated") {
      await existing.restart();
      return "restarted";
    }
    return "existing";
  }
  const created = await workflow.createBatch([
    {
      id: intendedInstanceId,
      params: { wait_id: waitId },
      retention: {
        successRetention: WORKFLOW_INSTANCE_RETENTION,
        errorRetention: WORKFLOW_INSTANCE_RETENTION,
      },
    },
  ]);
  if (created.some((instance) => instance.id !== intendedInstanceId)) {
    throw new LifecycleError("idempotency_state_ambiguous", "Workflow provisioning returned an unexpected instance identity.");
  }
  return "provisioned";
}
