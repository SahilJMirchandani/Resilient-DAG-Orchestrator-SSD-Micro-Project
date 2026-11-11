import { describe, expect, it } from "vitest";
import { topologicalSort, WorkflowValidationError } from "../src/dag.js";
import type { WorkflowDefinition } from "../src/types.js";

const task = (id: string, dependencies: string[] = []) => ({
  id, name: id, type: "test", dependencies,
});

describe("DAG validation", () => {
  it("returns a dependency-respecting topological order", () => {
    const workflow: WorkflowDefinition = {
      id: "valid", name: "valid",
      tasks: [task("finish", ["left", "right"]), task("left"), task("right", ["left"])],
    };
    const order = topologicalSort(workflow);
    expect(order.indexOf("left")).toBeLessThan(order.indexOf("right"));
    expect(order.indexOf("left")).toBeLessThan(order.indexOf("finish"));
    expect(order.indexOf("right")).toBeLessThan(order.indexOf("finish"));
  });

  it("rejects circular, missing, and duplicate dependencies", () => {
    expect(() => topologicalSort({
      id: "cycle", name: "cycle", tasks: [task("a", ["b"]), task("b", ["a"])],
    })).toThrow(WorkflowValidationError);
    expect(() => topologicalSort({
      id: "missing", name: "missing", tasks: [task("a", ["unknown"])],
    })).toThrow('unknown task "unknown"');
    expect(() => topologicalSort({
      id: "duplicate", name: "duplicate", tasks: [task("a"), task("a")],
    })).toThrow("Duplicate task ID");
  });
});
