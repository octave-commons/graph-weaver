import type { GraphEdge, GraphNode, GraphSnapshot } from "./graph.js";

export class GraphStore {
  private readonly nodesById = new Map<string, GraphNode>();
  private readonly edgesById = new Map<string, GraphEdge>();

  upsertNode(node: GraphNode): void {
    const prev = this.nodesById.get(node.id);
    const mergedData =
      prev?.data || node.data
        ? {
            ...(prev?.data ?? {}),
            ...(node.data ?? {}),
          }
        : undefined;
    this.nodesById.set(node.id, { ...(prev ?? {}), ...node, data: mergedData });
  }

  upsertEdge(edge: GraphEdge): void {
    const prev = this.edgesById.get(edge.id);
    const mergedData =
      prev?.data || edge.data
        ? {
            ...(prev?.data ?? {}),
            ...(edge.data ?? {}),
          }
        : undefined;
    this.edgesById.set(edge.id, { ...(prev ?? {}), ...edge, data: mergedData });
  }

  removeNode(id: string): boolean {
    const existed = this.nodesById.delete(id);
    if (!existed) return false;
    for (const [edgeId, edge] of this.edgesById.entries()) {
      if (edge.source === id || edge.target === id) {
        this.edgesById.delete(edgeId);
      }
    }
    return true;
  }

  removeEdge(id: string): boolean {
    return this.edgesById.delete(id);
  }

  hasNode(id: string): boolean {
    return this.nodesById.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  nodes(): IterableIterator<GraphNode> {
    return this.nodesById.values();
  }

  hasEdge(id: string): boolean {
    return this.edgesById.has(id);
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edgesById.get(id);
  }

  edges(): IterableIterator<GraphEdge> {
    return this.edgesById.values();
  }

  snapshot(): GraphSnapshot {
    return {
      nodes: [...this.nodesById.values()],
      edges: [...this.edgesById.values()],
    };
  }

  size(): { nodes: number; edges: number } {
    return { nodes: this.nodesById.size, edges: this.edgesById.size };
  }
}

export function mergeStores(a: GraphStore, b: GraphStore): GraphStore {
  const out = new GraphStore();
  for (const node of a.snapshot().nodes) out.upsertNode(node);
  for (const node of b.snapshot().nodes) out.upsertNode(node);
  for (const edge of a.snapshot().edges) out.upsertEdge(edge);
  for (const edge of b.snapshot().edges) out.upsertEdge(edge);
  return out;
}

export function mergeStoresMany(stores: GraphStore[]): GraphStore {
  const out = new GraphStore();
  for (const store of stores) {
    for (const node of store.snapshot().nodes) out.upsertNode(node);
    for (const edge of store.snapshot().edges) out.upsertEdge(edge);
  }
  return out;
}
