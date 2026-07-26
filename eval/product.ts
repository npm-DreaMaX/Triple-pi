export type ProductMode = "off" | "manual" | "async";

export interface ProductTask {
  id: string;
  setup: {
    project: string;
    rule: string;
    correctedRule?: string;
  };
  queryProject: string;
  expectedVisible: string[];
  expectedHidden: string[];
}

export interface ProductObservation {
  mode: ProductMode;
  taskId: string;
  visible: string[];
  passed: boolean;
  failures: string[];
}

export const PRODUCT_TASKS: ProductTask[] = [
  {
    id: "same-project-rule",
    setup: { project: "/product/A", rule: "Always run checkout tests." },
    queryProject: "/product/A",
    expectedVisible: ["checkout tests"],
    expectedHidden: [],
  },
  {
    id: "cross-project-isolation",
    setup: { project: "/product/A", rule: "Use project A release train." },
    queryProject: "/product/B",
    expectedVisible: [],
    expectedHidden: ["project A release train"],
  },
  {
    id: "correction-wins",
    setup: { project: "/product/A", rule: "Use REST for the API.", correctedRule: "Actually, use GraphQL instead of REST." },
    queryProject: "/product/A",
    expectedVisible: ["GraphQL"],
    expectedHidden: ["Use REST for the API"],
  },
];

export function evaluateProductVisibility(
  mode: ProductMode,
  task: ProductTask,
  prompt: string,
): ProductObservation {
  const lower = prompt.toLocaleLowerCase();
  const failures: string[] = [];
  for (const expected of task.expectedVisible) {
    if (!lower.includes(expected.toLocaleLowerCase())) failures.push(`Missing visible state: ${expected}`);
  }
  for (const hidden of task.expectedHidden) {
    if (lower.includes(hidden.toLocaleLowerCase())) failures.push(`Leaked hidden state: ${hidden}`);
  }
  if (mode === "off" && prompt.trim()) failures.push("Memory-off mode injected context");
  const visible = task.expectedVisible.filter((expected) => lower.includes(expected.toLocaleLowerCase()));
  return { mode, taskId: task.id, visible, passed: failures.length === 0, failures };
}
