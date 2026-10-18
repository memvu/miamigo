import { billingTools } from "./bills";
import type { ToolDefinition } from "./contracts";
import { planningTools } from "./planning";

export const tools: ToolDefinition[] = [
  ...planningTools,
  ...billingTools,
  {
    type: "function",
    function: {
      name: "no_reply",
      description: "Record a decision to remain silent. Do not send a message.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];
