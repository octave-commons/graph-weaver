import type { GraphSnapshot } from "./graph.js";

function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function groupKey(nodeId: string): string {
  if (nodeId.startsWith("file:")) {
    const rest = nodeId.slice("file:".length);
    const parts = rest.split("/");
    const a = parts[0] || "root";
    const b = parts[1] || "";

    // Split the biggest buckets into sub-groups so we don't get one mega-clump.
    if (a === "orgs" && b) return `orgs/${b}`;
    if (a === "packages" && b) return `packages/${b}`;
    if (a === "services" && b) return `services/${b}`;

    return a;
  }
  if (nodeId.startsWith("url:")) {
    try {
      return new URL(nodeId.slice("url:".length)).host;
    } catch {
      return "web";
    }
  }
  if (nodeId.startsWith("dep:")) return "deps";
  return "misc";
}

export function layoutGraph(snapshot: GraphSnapshot): Map<string, { x: number; y: number }> {
  const nodes = snapshot.nodes;
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const key = groupKey(n.id);
    const arr = groups.get(key) ?? [];
    arr.push(n.id);
    groups.set(key, arr);
  }

  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const anchors = new Map<string, { x: number; y: number }>();

  // Larger ring when there are many groups.
  const count = Math.max(1, keys.length);
  const ring = 360 + Math.min(760, Math.sqrt(count) * 46);
  keys.forEach((k, i) => {
    const a = (Math.PI * 2 * i) / count;
    anchors.set(k, { x: Math.cos(a) * ring, y: Math.sin(a) * ring * 0.78 });
  });

  const positions = new Map<string, { x: number; y: number }>();
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (const [key, ids] of groups) {
    ids.sort((a, b) => a.localeCompare(b));
    const base = anchors.get(key) ?? { x: 0, y: 0 };
    const keyPhase = ((hash32(key) % 628) / 100) * 0.85;

    // Spread within the group using a sunflower (Vogel) pattern.
    // This avoids the "clumpy rings" effect for large groups.
    const size = Math.max(1, ids.length);
    const rMax = 40 + Math.min(900, Math.sqrt(size) * 10);
    const spacing = rMax / Math.sqrt(size + 1);

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]!;
      const h = hash32(id);

      const depth = id.startsWith("file:") ? id.slice("file:".length).split("/").length : 2;
      const depthBias = Math.min(90, depth * 5);

      const angle = keyPhase + i * golden;
      const radial = spacing * Math.sqrt(i + 1) + depthBias;
      const jitter = (((h % 2000) / 2000) - 0.5) * spacing * 0.6;

      positions.set(id, {
        x: base.x + Math.cos(angle) * (radial + jitter),
        y: base.y + Math.sin(angle) * (radial + jitter) * 0.86,
      });
    }
  }

  return positions;
}
