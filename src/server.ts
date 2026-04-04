import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { GraphWeaverAco } from "@workspace/graph-weaver-aco";
import type { WeaverEvent } from "@workspace/graph-weaver-aco";

import type { GraphEdge, GraphNode, GraphSnapshot } from "./graph.js";
import { applyConfigPatch, defaultConfigFromEnv, type ConfigPatch, type RuntimeConfig } from "./config.js";
import { createGraphQLHandler } from "./graphql.js";
import { repoRootFromGit } from "./git.js";
import { layoutGraph } from "./layout.js";
import { MongoGraphStore } from "./mongo-graph-store.js";
import { readJsonIfExists, writeJson } from "./persist.js";
import type { NodePreview } from "./preview.js";
import { fetchUrlPreview, readFilePreview } from "./preview.js";
import { rebuildLocalGraph } from "./scan.js";
import { GraphStore, mergeStoresMany } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res: http.ServerResponse): void {
  res.statusCode = 404;
  res.end("not found");
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function serveFile(res: http.ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(data);
  } catch {
    notFound(res);
  }
}

function sampleByStride<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const stride = Math.max(1, Math.ceil(rows.length / max));
  const out: T[] = [];
  for (let i = 0; i < rows.length && out.length < max; i += stride) {
    out.push(rows[i]!);
  }
  return out;
}

function downsampleSnapshot(
  snapshot: { nodes: Array<{ id: string }>; edges: Array<{ id: string; source: string; target: string }> },
  opts: { maxNodes: number; maxEdges: number },
) {
  const totalNodes = snapshot.nodes.length;
  const totalEdges = snapshot.edges.length;

  if (totalNodes <= opts.maxNodes && totalEdges <= opts.maxEdges) {
    return {
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      sampledNodes: false,
      sampledEdges: false,
      totalNodes,
      totalEdges,
    };
  }

  let edges = snapshot.edges;
  let sampledEdges = false;
  if (edges.length > opts.maxEdges) {
    sampledEdges = true;
    edges = sampleByStride([...edges].sort((a, b) => a.id.localeCompare(b.id)), opts.maxEdges);
  }

  const computeKeep = (rows: Array<{ source: string; target: string }>) => {
    const keep = new Set<string>();
    for (const e of rows) {
      keep.add(e.source);
      keep.add(e.target);
    }
    return keep;
  };

  let keep = computeKeep(edges);
  while (keep.size > opts.maxNodes && edges.length > 200) {
    sampledEdges = true;
    const ratio = opts.maxNodes / Math.max(1, keep.size);
    const nextEdgeBudget = Math.max(200, Math.floor(edges.length * ratio));
    edges = sampleByStride(edges, nextEdgeBudget);
    keep = computeKeep(edges);
  }

  let nodes = snapshot.nodes.filter((n) => keep.has(n.id));
  let sampledNodes = nodes.length < totalNodes;

  if (nodes.length < opts.maxNodes) {
    const need = opts.maxNodes - nodes.length;
    const remaining = snapshot.nodes
      .filter((n) => !keep.has(n.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    nodes = [...nodes, ...sampleByStride(remaining, need)];
    sampledNodes = true;
  }

  const nodeSet = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));

  return { nodes, edges, sampledNodes, sampledEdges, totalNodes, totalEdges };
}

function stableStateDir(repoRoot: string): string {
  const raw = String(process.env.STATE_DIR || "").trim();
  if (!raw) {
    return path.join(repoRoot, ".opencode", "runtime");
  }
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function posFromData(data: unknown): { x: number; y: number } | null {
  if (!data || typeof data !== "object") return null;
  const pos = (data as { pos?: unknown }).pos;
  if (!pos || typeof pos !== "object") return null;
  const x = (pos as { x?: unknown }).x;
  const y = (pos as { y?: unknown }).y;
  if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
    // Guardrail: bad layout writers can explode coordinates and ruin fit-to-graph.
    // We soft-clamp to a max radius so the view remains usable.
    const maxR = 5000;
    const r = Math.sqrt(x * x + y * y);
    if (r > maxR && r > 0) {
      const s = maxR / r;
      return { x: x * s, y: y * s };
    }
    return { x, y };
  }
  return null;
}

function safeResolveUnderRoot(rootDir: string, relPath: string): string | null {
  const root = path.resolve(rootDir);
  const abs = path.resolve(rootDir, relPath);
  if (abs === root) return abs;
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

async function main(): Promise<void> {
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || "8796");
  const repoRoot = process.env.REPO_ROOT || (await repoRootFromGit(process.cwd())) || process.cwd();

  const vendorWebglDist =
    process.env.WEBGL_GRAPH_VIEW_DIST || path.join(repoRoot, "packages/webgl-graph-view/dist");
  const publicDir = path.join(__dirname, "..", "public");

  const stateDir = stableStateDir(repoRoot);
  const configPath = path.join(stateDir, "devel-graph-weaver.config.json");
  const legacyUserGraphPath = path.join(stateDir, "devel-graph-weaver.user-graph.json");

  const mongoGraph = new MongoGraphStore({
    uri: String(process.env.MONGODB_URI || "mongodb://mongodb:27017").trim(),
    dbName: String(process.env.MONGODB_DB || "devel_graph_weaver").trim(),
    appName: "devel-graph-weaver",
  });
  await mongoGraph.connect();

  // --- config
  let config: RuntimeConfig = defaultConfigFromEnv(process.env);
  const storedConfig = await readJsonIfExists<ConfigPatch>(configPath);
  if (storedConfig) {
    config = applyConfigPatch(config, storedConfig);
  }

  let configSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSaveConfig = () => {
    if (configSaveTimer) return;
    configSaveTimer = setTimeout(() => {
      configSaveTimer = null;
      void writeJson(configPath, config).catch(() => {});
    }, 250);
  };

  // --- graph stores
  let localStore = new GraphStore();
  const webStore = new GraphStore();
  const userStore = new GraphStore();

  const loadSnapshotIntoStore = (store: GraphStore, snapshot: GraphSnapshot) => {
    for (const node of snapshot.nodes) store.upsertNode(node);
    for (const edge of snapshot.edges) store.upsertEdge(edge);
  };

  // persisted graph load (MongoDB datalake)
  loadSnapshotIntoStore(webStore, await mongoGraph.loadStore("web"));

  const storedUser = await mongoGraph.loadStore("user");
  if (storedUser.nodes.length > 0 || storedUser.edges.length > 0) {
    loadSnapshotIntoStore(userStore, storedUser);
  } else {
    // one-time legacy migration from the old JSON snapshot, if it exists and parses.
    const legacyUser = await readJsonIfExists<GraphSnapshot>(legacyUserGraphPath);
    if (legacyUser?.nodes && legacyUser?.edges) {
      loadSnapshotIntoStore(userStore, legacyUser);
      await mongoGraph.bulkUpsertNodes("user", legacyUser.nodes);
      await mongoGraph.bulkUpsertEdges("user", legacyUser.edges);

      try {
        await fs.rename(legacyUserGraphPath, `${legacyUserGraphPath}.migrated`);
      } catch {
        // ignore: non-fatal if rename fails or file doesn't exist.
      }
    }
  }

  // --- revision + WS broadcast + combined cache
  let revision = 0;
  let combinedCache: { revision: number; store: GraphStore } | null = null;

  const broadcast = new Set<() => void>();
  const markDirty = () => {
    revision += 1;
    combinedCache = null;
    for (const cb of broadcast) cb();
  };

  const getCombinedStore = (): GraphStore => {
    if (combinedCache && combinedCache.revision === revision) return combinedCache.store;
    const combined = mergeStoresMany([localStore, webStore, userStore]);
    combinedCache = { revision, store: combined };
    return combined;
  };

  // --- local rebuild (scan)
  let lastSeeds: string[] = [];

  async function rebuildLocal(): Promise<void> {
    const fresh = new GraphStore();
    const { seeds } = await rebuildLocalGraph({
      repoRoot,
      store: fresh,
      maxFileBytes: config.scan.maxFileBytes,
    });
    lastSeeds = seeds;
    localStore = fresh;
    markDirty();
  }

  // --- weaver
  let weaver: GraphWeaverAco | null = null;

  const onWeaverEvent = (ev: WeaverEvent) => {
    if (ev.type === "page") {
      const fromId = `url:${ev.url}`;
      const pageNode: GraphNode = {
        id: fromId,
        kind: "url",
        label: ev.url,
        external: true,
        loadedByDefault: false,
        layer: "web",
        url: ev.url,
        data: {
          url: ev.url,
          status: ev.status,
          contentType: ev.contentType,
          fetchedAt: ev.fetchedAt,
        },
      };
      webStore.upsertNode(pageNode);

      const touchedNodes: GraphNode[] = [pageNode];
      const touchedEdges: GraphEdge[] = [];

      for (const out of ev.outgoing) {
        const toId = `url:${out}`;
        const outNode: GraphNode = {
          id: toId,
          kind: "url",
          label: out,
          external: true,
          loadedByDefault: false,
          layer: "web",
          url: out,
          data: { url: out },
        };
        const outEdge: GraphEdge = {
          id: `${fromId}=>${toId}:web`,
          source: fromId,
          target: toId,
          kind: "web",
          layer: "web",
        };

        webStore.upsertNode(outNode);
        webStore.upsertEdge(outEdge);
        touchedNodes.push(outNode);
        touchedEdges.push(outEdge);
      }

      void (async () => {
        await mongoGraph.bulkUpsertNodes("web", touchedNodes);
        await mongoGraph.bulkUpsertEdges("web", touchedEdges);
      })().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[devel-graph-weaver] failed to persist web page event", err);
      });

      markDirty();
      return;
    }

    if (ev.type === "error") {
      const nodeId = `url:${ev.url}`;
      const errorNode: GraphNode = {
        id: nodeId,
        kind: "url",
        label: ev.url,
        external: true,
        loadedByDefault: false,
        layer: "web",
        url: ev.url,
        data: { url: ev.url, error: ev.message, fetchedAt: ev.fetchedAt },
      };
      webStore.upsertNode(errorNode);
      void mongoGraph.upsertNode("web", errorNode).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[devel-graph-weaver] failed to persist web error event", err);
      });
      markDirty();
    }
  };

  const createWeaver = () =>
    new GraphWeaverAco({
      ants: config.weaver.ants,
      dispatchIntervalMs: config.weaver.dispatchIntervalMs,
      maxConcurrency: config.weaver.maxConcurrency,
      perHostMinIntervalMs: config.weaver.perHostMinIntervalMs,
      revisitAfterMs: config.weaver.revisitAfterMs,
      alpha: config.weaver.alpha,
      beta: config.weaver.beta,
      evaporation: config.weaver.evaporation,
      deposit: config.weaver.deposit,
      requestTimeoutMs: config.weaver.requestTimeoutMs,
    });

  const startWeaver = () => {
    if (weaver) {
      weaver.stop();
      weaver = null;
    }
    weaver = createWeaver();
    weaver.onEvent(onWeaverEvent);
    weaver.seed(lastSeeds);
    weaver.start();
  };

  // boot
  await rebuildLocal();
  startWeaver();

  // scan timer
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  const resetRescanTimer = () => {
    if (rescanTimer) {
      clearInterval(rescanTimer);
    }
    rescanTimer = setInterval(() => {
      void (async () => {
        await rebuildLocal();
        weaver?.seed(lastSeeds);
        markDirty();
      })();
    }, config.scan.rescanIntervalMs);
  };
  resetRescanTimer();

  // --- graph view
  const buildGraphView = (opts?: { maxNodes?: number; maxEdges?: number }) => {
    const combined = getCombinedStore().snapshot();

    const maxNodes = Math.max(200, Math.floor(opts?.maxNodes ?? config.render.maxRenderNodes));
    const maxEdges = Math.max(200, Math.floor(opts?.maxEdges ?? config.render.maxRenderEdges));

    const sampled = downsampleSnapshot(combined, { maxNodes, maxEdges });
    const positions = layoutGraph({
      nodes: sampled.nodes as unknown as GraphNode[],
      edges: sampled.edges as unknown as GraphEdge[],
    });

    return {
      nodes: (sampled.nodes as unknown as GraphNode[]).map((n) => {
        const override = posFromData(n.data);
        const p = override ?? positions.get(n.id) ?? { x: 0, y: 0 };
        return {
          id: n.id,
          kind: n.kind,
          label: n.label,
          x: p.x,
          y: p.y,
          external: n.external,
          loadedByDefault: n.loadedByDefault,
          layer: n.layer,
          data: n.data,
        };
      }),
      edges: (sampled.edges as unknown as GraphEdge[]).map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
        layer: e.layer,
        data: e.data,
      })),
      meta: {
        totalNodes: sampled.totalNodes,
        totalEdges: sampled.totalEdges,
        sampledNodes: sampled.sampledNodes,
        sampledEdges: sampled.sampledEdges,
      },
    };
  };

  const getStatus = () => {
    const combined = getCombinedStore();
    const { nodes, edges } = combined.size();
    return {
      nodes,
      edges,
      seeds: lastSeeds.length,
      weaver: weaver?.stats() ?? { frontier: 0, inFlight: 0 },
      render: config.render,
      scan: config.scan,
    };
  };

  const getNode = (id: string) => {
    const node = getCombinedStore().getNode(id);
    return node ?? null;
  };

  const getEdge = (id: string) => {
    const edge = getCombinedStore().getEdge(id);
    return edge ?? null;
  };

  const listEdges = (filter: { source?: string; target?: string; kind?: string; limit: number }) => {
    const out: GraphEdge[] = [];
    const cap = Math.max(1, Math.min(2000, Math.floor(filter.limit)));
    const kind = filter.kind;
    for (const edge of getCombinedStore().edges()) {
      if (filter.source && edge.source !== filter.source) continue;
      if (filter.target && edge.target !== filter.target) continue;
      if (kind && edge.kind !== kind) continue;
      out.push(edge);
      if (out.length >= cap) break;
    }
    return out;
  };

  const neighbors = (filter: { id: string; direction: "in" | "out" | "both"; kind?: string; limit: number }) => {
    const out: GraphNode[] = [];
    const cap = Math.max(1, Math.min(2000, Math.floor(filter.limit)));

    const seen = new Set<string>();
    for (const edge of getCombinedStore().edges()) {
      if (filter.kind && edge.kind !== filter.kind) continue;
      if (filter.direction === "out" || filter.direction === "both") {
        if (edge.source === filter.id) {
          const id = edge.target;
          if (!seen.has(id)) {
            const node = getCombinedStore().getNode(id);
            if (node) {
              out.push(node);
              seen.add(id);
              if (out.length >= cap) break;
            }
          }
        }
      }
      if (filter.direction === "in" || filter.direction === "both") {
        if (edge.target === filter.id) {
          const id = edge.source;
          if (!seen.has(id)) {
            const node = getCombinedStore().getNode(id);
            if (node) {
              out.push(node);
              seen.add(id);
              if (out.length >= cap) break;
            }
          }
        }
      }
    }
    return out;
  };

  const searchNodes = (query: string, limit: number) => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const cap = Math.max(1, Math.min(500, Math.floor(limit)));

    const out: GraphNode[] = [];
    for (const node of getCombinedStore().nodes()) {
      const hay = `${node.id} ${node.kind} ${node.label} ${(node.path ?? "")} ${(node.url ?? "")} ${(node.dep ?? "")}`.toLowerCase();
      if (hay.includes(q)) {
        out.push(node);
        if (out.length >= cap) break;
      }
    }
    return out;
  };

  const nodePreview = async (id: string, maxBytes: number): Promise<NodePreview | null> => {
    const node = getCombinedStore().getNode(id);
    if (!node) return null;

    try {
      // files
      if (node.kind === "file" || id.startsWith("file:")) {
        const relPath = node.path ?? id.slice("file:".length);
        const absPath = safeResolveUnderRoot(repoRoot, relPath);
        if (!absPath) {
          return {
            id,
            kind: node.kind,
            format: "error",
            contentType: "text/plain; charset=utf-8",
            language: null,
            body: null,
            truncated: false,
            bytes: 0,
            error: "invalid file path",
          };
        }
        const p = await readFilePreview({ absPath, relPath, maxBytes });
        return { id, kind: node.kind, ...p };
      }

      // urls
      if (node.kind === "url" || id.startsWith("url:")) {
        const url = node.url ?? id.slice("url:".length);
        const p = await fetchUrlPreview({ url, maxBytes, timeoutMs: config.weaver.requestTimeoutMs });
        return { id, kind: node.kind, ...p };
      }

      // deps / other nodes: metadata-only (markdownable)
      const body = JSON.stringify(node, null, 2);
      return {
        id,
        kind: node.kind,
        format: "code",
        contentType: "application/json; charset=utf-8",
        language: "json",
        body,
        truncated: false,
        bytes: Buffer.byteLength(body),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id,
        kind: node.kind,
        format: "error",
        contentType: "text/plain; charset=utf-8",
        language: null,
        body: message,
        truncated: false,
        bytes: Buffer.byteLength(message),
        error: message,
      };
    }
  };

  // --- mutations (user layer)
  const ensureNodeExistsForEdge = (id: string): GraphNode | null => {
    if (getCombinedStore().hasNode(id)) return null;
    userStore.upsertNode({
      id,
      kind: "placeholder",
      label: id,
      external: true,
      loadedByDefault: false,
      layer: "user",
      data: { note: "created as edge endpoint" },
    });
    return userStore.getNode(id) ?? null;
  };

  const upsertUserNode = async (input: {
    id: string;
    kind?: string;
    label?: string;
    external?: boolean;
    loadedByDefault?: boolean;
    data?: Record<string, unknown>;
  }) => {
    const prev = userStore.getNode(input.id);

    // If this node already exists in the derived layers (local/web), and the caller is
    // *only* patching data, we treat it as an overlay patch rather than an override.
    const base = localStore.getNode(input.id) ?? webStore.getNode(input.id) ?? null;
    const isOverlayPatch =
      !!base &&
      input.kind === undefined &&
      input.label === undefined &&
      input.external === undefined &&
      input.loadedByDefault === undefined;

    const node: GraphNode = {
      id: input.id,
      kind: input.kind ?? prev?.kind ?? base?.kind ?? "user",
      label: input.label ?? prev?.label ?? base?.label ?? input.id,
      external: input.external ?? prev?.external ?? base?.external ?? false,
      loadedByDefault: input.loadedByDefault ?? prev?.loadedByDefault ?? base?.loadedByDefault ?? true,
      layer: isOverlayPatch ? base?.layer : "user",
      data: input.data ?? undefined,
    };
    userStore.upsertNode(node);
    const stored = userStore.getNode(node.id)!;
    await mongoGraph.upsertNode("user", stored);
    markDirty();
    return stored;
  };

  const layoutUpsertPositions = async (inputs: Array<{ id: string; x: number; y: number }>): Promise<number> => {
    let updated = 0;
    const touched: GraphNode[] = [];

    for (const row of inputs) {
      const id = String(row?.id || "").trim();
      if (!id) continue;

      const x = Number((row as any).x);
      const y = Number((row as any).y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const base = localStore.getNode(id) ?? webStore.getNode(id) ?? null;
      const prev = userStore.getNode(id);

      const kind = base?.kind ?? prev?.kind ?? "user";
      const label = base?.label ?? prev?.label ?? id;
      const external = base?.external ?? prev?.external ?? (id.startsWith("url:") || id.startsWith("dep:"));
      const loadedByDefault = base?.loadedByDefault ?? prev?.loadedByDefault ?? true;
      const layer = base?.layer ?? prev?.layer ?? "user";

      userStore.upsertNode({
        id,
        kind,
        label,
        external,
        loadedByDefault,
        layer,
        data: { pos: { x, y } },
      });
      const stored = userStore.getNode(id);
      if (stored) touched.push(stored);
      updated += 1;
    }

    if (updated > 0) {
      await mongoGraph.bulkUpsertNodes("user", touched);
      markDirty();
    }
    return updated;
  };

  const upsertUserEdge = async (input: {
    id: string;
    source: string;
    target: string;
    kind?: string;
    data?: Record<string, unknown>;
  }) => {
    const createdA = ensureNodeExistsForEdge(input.source);
    const createdB = ensureNodeExistsForEdge(input.target);

    const prev = userStore.getEdge(input.id);
    const edge: GraphEdge = {
      id: input.id,
      source: input.source,
      target: input.target,
      kind: input.kind ?? prev?.kind ?? "user",
      layer: "user",
      data: input.data ?? undefined,
    };
    userStore.upsertEdge(edge);
    const writes: Promise<void>[] = [];
    const touchedNodes = [createdA, createdB].filter((node): node is GraphNode => !!node);
    if (touchedNodes.length > 0) writes.push(mongoGraph.bulkUpsertNodes("user", touchedNodes));
    writes.push(mongoGraph.upsertEdge("user", userStore.getEdge(edge.id)!));
    await Promise.all(writes);
    markDirty();
    return userStore.getEdge(edge.id)!;
  };

  const removeUserNode = async (id: string): Promise<boolean> => {
    const ok = userStore.removeNode(id);
    if (ok) {
      await mongoGraph.removeNode("user", id);
      markDirty();
    }
    return ok;
  };

  const removeUserEdge = async (id: string): Promise<boolean> => {
    const ok = userStore.removeEdge(id);
    if (ok) {
      await mongoGraph.removeEdge("user", id);
      markDirty();
    }
    return ok;
  };

  const seedUrls = (urls: string[]) => {
    weaver?.seed(urls);
    markDirty();
  };

  const rescanNow = async () => {
    await rebuildLocal();
    weaver?.seed(lastSeeds);
    markDirty();
  };

  const updateConfig = async (patch: ConfigPatch) => {
    const prev = config;
    config = applyConfigPatch(config, patch);
    scheduleSaveConfig();

    const weaverChanged = !deepEqualJson(prev.weaver, config.weaver);
    if (weaverChanged) {
      startWeaver();
    }

    const scanChanged = !deepEqualJson(prev.scan, config.scan);
    if (scanChanged) {
      resetRescanTimer();
    }

    markDirty();
    return config;
  };

  const graphqlHandler = createGraphQLHandler({
    adminToken: String(process.env.GRAPH_WEAVER_ADMIN_TOKEN || "").trim() || null,
    getConfig: () => config,
    updateConfig,
    getStatus,
    getGraphView: (opts) => buildGraphView(opts),
    getNode: (id) => getNode(id),
    getEdge: (id) => getEdge(id),
    listEdges,
    neighbors,
    searchNodes,
    nodePreview,
    rescanNow,
    seedUrls,
    upsertUserNode,
    upsertUserEdge,
    removeUserNode,
    removeUserEdge,
    layoutUpsertPositions,
  });

  // --- HTTP server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/graphql") {
      await graphqlHandler(req, res);
      return;
    }

    if (pathname === "/api/status") {
      json(res, 200, getStatus());
      return;
    }

    if (pathname === "/api/graph") {
      json(res, 200, buildGraphView());
      return;
    }

    if (pathname.startsWith("/vendor/webgl-graph-view/")) {
      const rest = pathname.slice("/vendor/webgl-graph-view/".length);
      const filePath = path.join(vendorWebglDist, rest);
      await serveFile(res, filePath);
      return;
    }

    // static public
    if (pathname === "/") {
      await serveFile(res, path.join(publicDir, "index.html"));
      return;
    }
    if (pathname === "/graphiql") {
      await serveFile(res, path.join(publicDir, "graphiql.html"));
      return;
    }
    if (pathname === "/app.js" || pathname === "/style.css") {
      await serveFile(res, path.join(publicDir, pathname.slice(1)));
      return;
    }

    notFound(res);
  });

  // --- WebSocket "changed" notifications
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const push = () => {
      try {
        ws.send("changed");
      } catch {
        // ignore
      }
    };
    broadcast.add(push);
    ws.on("close", () => broadcast.delete(push));
    ws.on("error", () => broadcast.delete(push));
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[devel-graph-weaver] shutting down on ${signal}`);
    void mongoGraph.close().catch(() => {});
    if (rescanTimer) clearInterval(rescanTimer);
    try {
      wss.close();
    } catch {
      // ignore
    }
    server.close();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[devel-graph-weaver] http://${host}:${port} repo=${repoRoot}`);
    // eslint-disable-next-line no-console
    console.log(`[devel-graph-weaver] graphql http://${host}:${port}/graphql · graphiql http://${host}:${port}/graphiql`);
    // eslint-disable-next-line no-console
    console.log(`[devel-graph-weaver] stateDir ${stateDir}`);
    // eslint-disable-next-line no-console
    console.log(`[devel-graph-weaver] mongo ${String(process.env.MONGODB_URI || "mongodb://mongodb:27017").trim()} db=${String(process.env.MONGODB_DB || "devel_graph_weaver").trim()}`);
  });
}

void main();
