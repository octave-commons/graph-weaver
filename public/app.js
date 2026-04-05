import { WebGLGraphView, rgba } from "/vendor/webgl-graph-view/index.js";

const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const nodeEl = document.getElementById("node");
const legendEl = document.getElementById("legend");
const filtersEl = document.getElementById("filters");

const fitBtn = document.getElementById("fit");
const reloadBtn = document.getElementById("reload");
const applyBtn = document.getElementById("apply");
const rescanNowBtn = document.getElementById("rescanNow");

const ui = {
  renderNodes: /** @type {HTMLInputElement} */ (document.getElementById("renderNodes")),
  renderEdges: /** @type {HTMLInputElement} */ (document.getElementById("renderEdges")),
  ants: /** @type {HTMLInputElement} */ (document.getElementById("ants")),
  dispatch: /** @type {HTMLInputElement} */ (document.getElementById("dispatch")),
  concurrency: /** @type {HTMLInputElement} */ (document.getElementById("concurrency")),
  perHost: /** @type {HTMLInputElement} */ (document.getElementById("perHost")),
  revisit: /** @type {HTMLInputElement} */ (document.getElementById("revisit")),
  rescan: /** @type {HTMLInputElement} */ (document.getElementById("rescan")),

  vRenderNodes: document.getElementById("v-renderNodes"),
  vRenderEdges: document.getElementById("v-renderEdges"),
  vAnts: document.getElementById("v-ants"),
  vDispatch: document.getElementById("v-dispatch"),
  vConcurrency: document.getElementById("v-concurrency"),
  vPerHost: document.getElementById("v-perHost"),
  vRevisit: document.getElementById("v-revisit"),
  vRescan: document.getElementById("v-rescan"),
};

const LAKE_COLORS = {
  devel: [0.24, 0.72, 0.98, 0.96],
  web: [0.39, 0.92, 0.68, 0.96],
  bluesky: [0.31, 0.63, 0.98, 0.96],
  misc: [0.7, 0.74, 0.82, 0.94],
};

const NODE_TYPE_VARIANTS = {
  docs: { size: 6.2, tint: 0.18 },
  code: { size: 5.4, tint: -0.02 },
  config: { size: 5.2, tint: 0.1 },
  data: { size: 6.0, tint: 0.24 },
  visited: { size: 5.6, tint: 0.08 },
  unvisited: { size: 4.8, tint: 0.34 },
  user: { size: 6.4, tint: -0.08 },
  post: { size: 5.1, tint: 0.22 },
  node: { size: 4.8, tint: 0 },
};

const EDGE_COLORS = {
  local_markdown_link: [0.97, 0.79, 0.38, 0.24],
  external_web_link: [0.97, 0.55, 0.34, 0.28],
  code_dependency: [0.66, 0.52, 0.98, 0.24],
  visited_to_visited: [0.29, 0.92, 0.63, 0.16],
  visited_to_unvisited: [0.35, 0.82, 0.57, 0.22],
  follows_user: [0.41, 0.67, 1.0, 0.2],
  authored_post: [0.73, 0.57, 0.98, 0.24],
  shared_post: [0.98, 0.67, 0.41, 0.24],
  liked_post: [0.98, 0.41, 0.66, 0.24],
  post_links_visited_web: [0.28, 0.86, 0.94, 0.24],
  post_links_unvisited_web: [0.2, 0.78, 0.92, 0.3],
  relation: [0.74, 0.78, 0.9, 0.14],
};

const filterState = {
  lakes: null,
  nodeTypes: null,
  edgeTypes: null,
  crossLake: "all",
};

let fullGraph = null;

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(input) {
  // same as escapeHtml; explicit name so it reads clearly in templates
  return escapeHtml(input);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseDataJson(maybeJson) {
  if (!maybeJson) return null;
  try {
    return JSON.parse(maybeJson);
  } catch {
    return { note: "invalid json", raw: maybeJson };
  }
}

function rgbaCss(color) {
  const [r, g, b, a] = color;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

function inferLake(node) {
  return node?.data?.lake || node?.lake || (String(node?.id || "").split(":", 1)[0] || "misc");
}

function inferNodeType(node) {
  return node?.data?.node_type || node?.nodeType || node?.kind || "node";
}

function inferEdgeType(edge) {
  return edge?.data?.edge_type || edge?.kind || "relation";
}

function isCrossLake(edge) {
  const sourceLake = edge?.data?.source_lake || edge?.sourceLake || edge?.source?.split(":", 1)?.[0];
  const targetLake = edge?.data?.target_lake || edge?.targetLake || edge?.target?.split(":", 1)?.[0];
  return Boolean(sourceLake && targetLake && sourceLake !== targetLake);
}

function lighten(color, amount) {
  const [r, g, b, a] = color;
  const mix = (v) => (amount >= 0 ? v + (1 - v) * amount : v * (1 + amount));
  return [mix(r), mix(g), mix(b), a];
}

function nodeColor(node) {
  const lake = inferLake(node);
  const nodeType = inferNodeType(node);
  const base = LAKE_COLORS[lake] || LAKE_COLORS.misc;
  const variant = NODE_TYPE_VARIANTS[nodeType] || NODE_TYPE_VARIANTS.node;
  return lighten(base, variant.tint || 0);
}

function nodeSize(node) {
  const nodeType = inferNodeType(node);
  return (NODE_TYPE_VARIANTS[nodeType] || NODE_TYPE_VARIANTS.node).size;
}

function edgeColor(edge) {
  const edgeType = inferEdgeType(edge);
  const base = EDGE_COLORS[edgeType] || EDGE_COLORS.relation;
  return isCrossLake(edge) ? [base[0], base[1], base[2], Math.min(0.34, base[3] + 0.08)] : base;
}

function shortNode(id) {
  if (!id) return "";
  if (id.includes(":file:")) {
    const rel = id.split(":file:")[1] || id;
    return rel.split("/").slice(-1)[0] || rel;
  }
  if (id.startsWith("dep:")) return id.slice("dep:".length);
  if (id.includes(":url:")) {
    const url = id.split(":url:")[1] || id;
    try {
      const u = new URL(url);
      return u.host;
    } catch {
      return url;
    }
  }
  return id;
}

function highlightAll(container) {
  const hljs = window.hljs;
  if (!hljs) return;
  container.querySelectorAll("pre code").forEach((el) => {
    try {
      hljs.highlightElement(el);
    } catch {
      // ignore
    }
  });
}

function markdownToHtml(md) {
  const marked = window.marked;
  const html = marked && typeof marked.parse === "function" ? marked.parse(md, { mangle: false, headerIds: false }) : `<pre>${escapeHtml(md)}</pre>`;
  const purify = window.DOMPurify;
  return purify && typeof purify.sanitize === "function" ? purify.sanitize(html) : html;
}

function htmlToMarkdown(html, baseUrl) {
  const TurndownService = window.TurndownService;
  if (!TurndownService) return "";

  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");

  // remove noisy / unsafe blocks before conversion
  doc.querySelectorAll("script,style,noscript").forEach((el) => el.remove());

  // normalize relative links so markdown is useful
  try {
    const base = baseUrl ? new URL(baseUrl) : null;
    if (base) {
      doc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!href) return;
        try {
          a.setAttribute("href", new URL(href, base).toString());
        } catch {
          // ignore
        }
      });

      doc.querySelectorAll("img[src]").forEach((img) => {
        const src = img.getAttribute("src") || "";
        if (!src) return;
        try {
          img.setAttribute("src", new URL(src, base).toString());
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }

  const td = new TurndownService({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
  });

  const gfm = window.turndownPluginGfm;
  // plugin shape varies by bundler; handle a couple common patterns
  if (gfm) {
    if (typeof gfm.gfm === "function") td.use(gfm.gfm);
    else if (typeof gfm === "function") td.use(gfm);
  }

  return td.turndown(doc.body);
}

async function gql(query, variables) {
  const res = await fetch("/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }
  return payload.data;
}

const view = new WebGLGraphView(canvas, {
  background: rgba(0.03, 0.06, 0.11, 0.98),
  pulseAmplitude: 0.42,
  pulseSpeed: 1 / 420,
  denseNodeThreshold: 4000,
  denseEdgeThreshold: 16000,
  dprCap: { normal: 2.5, dense: 2.0 },
  frameIntervalMs: { normal: 16, dense: 24 },
  onNodeClick: (node) => {
    void selectNodeById(node.id);
  },
  nodeStyle: (node) => {
    return { sizePx: nodeSize(node), color: nodeColor(node) };
  },
  edgeStyle: (edge) => {
    const aMul = edgeAlphaScale;
    const color = edgeColor(edge);
    return {
      color: rgba(color[0], color[1], color[2], color[3] * aMul),
      phase: isCrossLake(edge) ? 1.2 : 0,
    };
  },
});

let edgeAlphaScale = 1;

function edgeAlphaScaleForCount(edgeCount) {
  const base = 12000;
  if (edgeCount <= base) return 1;
  return Math.max(0.06, Math.sqrt(base / Math.max(1, edgeCount)));
}

let lastMeta = null;
let lastRenderCounts = { nodes: 0, edges: 0 };
let lastGraphNodesById = new Map();

function renderLegend(graph) {
  if (!legendEl) return;

  const lakes = [...new Set(graph.nodes.map((node) => inferLake(node)))].sort();
  const nodeTypes = [...new Set(graph.nodes.map((node) => inferNodeType(node)))].sort();
  const edgeTypes = [...new Set(graph.edges.map((edge) => inferEdgeType(edge)))].sort();

  const section = (title, rows) => `
    <div class="legendSection">
      <div class="legendTitle">${escapeHtml(title)}</div>
      <div class="legendItems">${rows.join("\n")}</div>
    </div>
  `;

  legendEl.innerHTML = [
    section(
      "lakes",
      lakes.map((lake) => {
        const color = rgbaCss(LAKE_COLORS[lake] || LAKE_COLORS.misc);
        return `<div class="legendItem"><span class="swatch" style="background:${escapeAttr(color)}"></span><span>${escapeHtml(lake)}</span></div>`;
      }),
    ),
    section(
      "node types",
      nodeTypes.map((nodeType) => {
        const variant = NODE_TYPE_VARIANTS[nodeType] || NODE_TYPE_VARIANTS.node;
        return `<div class="legendItem"><span class="swatch swatchNode" style="background:${escapeAttr(rgbaCss(lighten(LAKE_COLORS.devel, variant.tint || 0)))}"></span><span>${escapeHtml(nodeType)}</span></div>`;
      }),
    ),
    section(
      "edge types",
      edgeTypes.map((edgeType) => {
        const color = rgbaCss(EDGE_COLORS[edgeType] || EDGE_COLORS.relation);
        return `<div class="legendItem"><span class="swatch swatchEdge" style="background:${escapeAttr(color)}"></span><span>${escapeHtml(edgeType)}</span></div>`;
      }),
    ),
    `<div class="legendNote">Cross-lake edges pulse and use brighter strokes.</div>`,
  ].join("\n");
}

function ensureFilterSelections(graph) {
  const lakes = graph.nodes.map((node) => inferLake(node));
  const nodeTypes = graph.nodes.map((node) => inferNodeType(node));
  const edgeTypes = graph.edges.map((edge) => inferEdgeType(edge));
  if (!filterState.lakes) filterState.lakes = new Set(lakes);
  else lakes.forEach((value) => filterState.lakes.add(value));
  if (!filterState.nodeTypes) filterState.nodeTypes = new Set(nodeTypes);
  else nodeTypes.forEach((value) => filterState.nodeTypes.add(value));
  if (!filterState.edgeTypes) filterState.edgeTypes = new Set(edgeTypes);
  else edgeTypes.forEach((value) => filterState.edgeTypes.add(value));
}

function renderFilters(graph) {
  if (!filtersEl) return;
  ensureFilterSelections(graph);

  const lakeOptions = [...new Set(graph.nodes.map((node) => inferLake(node)))].sort();
  const nodeTypeOptions = [...new Set(graph.nodes.map((node) => inferNodeType(node)))].sort();
  const edgeTypeOptions = [...new Set(graph.edges.map((edge) => inferEdgeType(edge)))].sort();

  const checkbox = (group, value, checked) => `
    <label class="filterOption">
      <input type="checkbox" data-filter-group="${escapeAttr(group)}" data-filter-value="${escapeAttr(value)}" ${checked ? "checked" : ""} />
      <span>${escapeHtml(value)}</span>
    </label>
  `;

  filtersEl.innerHTML = `
    <div class="legendSection">
      <div class="legendTitle">lakes</div>
      <div class="filterGroup">${lakeOptions.map((value) => checkbox("lake", value, filterState.lakes.has(value))).join("\n")}</div>
    </div>
    <div class="legendSection">
      <div class="legendTitle">node types</div>
      <div class="filterGroup">${nodeTypeOptions.map((value) => checkbox("nodeType", value, filterState.nodeTypes.has(value))).join("\n")}</div>
    </div>
    <div class="legendSection">
      <div class="legendTitle">edge types</div>
      <div class="filterGroup">${edgeTypeOptions.map((value) => checkbox("edgeType", value, filterState.edgeTypes.has(value))).join("\n")}</div>
    </div>
    <div class="legendSection">
      <div class="legendTitle">relations</div>
      <div class="filterRadios">
        <label class="filterOption"><input type="radio" name="crossLake" value="all" ${filterState.crossLake === "all" ? "checked" : ""} /> <span>all edges</span></label>
        <label class="filterOption"><input type="radio" name="crossLake" value="cross" ${filterState.crossLake === "cross" ? "checked" : ""} /> <span>cross-lake only</span></label>
        <label class="filterOption"><input type="radio" name="crossLake" value="intra" ${filterState.crossLake === "intra" ? "checked" : ""} /> <span>intra-lake only</span></label>
      </div>
    </div>
  `;
}

function applyGraphFilters() {
  if (!fullGraph) return;

  const nodes = fullGraph.nodes.filter((node) => filterState.lakes.has(inferLake(node)) && filterState.nodeTypes.has(inferNodeType(node)));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = fullGraph.edges.filter((edge) => {
    if (!filterState.edgeTypes.has(inferEdgeType(edge))) return false;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
    if (filterState.crossLake === "cross" && !isCrossLake(edge)) return false;
    if (filterState.crossLake === "intra" && isCrossLake(edge)) return false;
    return true;
  });

  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const filteredNodes = nodes.filter((node) => visibleNodeIds.has(node.id));

  lastGraphNodesById = new Map(filteredNodes.map((node) => [node.id, node]));
  lastRenderCounts = { nodes: filteredNodes.length, edges: edges.length };
  edgeAlphaScale = edgeAlphaScaleForCount(lastRenderCounts.edges);
  view.setGraph({ nodes: filteredNodes, edges, meta: fullGraph.meta });
}

filtersEl?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const group = target.getAttribute("data-filter-group");
  const value = target.getAttribute("data-filter-value");

  if (group === "lake" && value) {
    if (target.checked) filterState.lakes.add(value);
    else filterState.lakes.delete(value);
    applyGraphFilters();
    void loadStatus();
    return;
  }

  if (group === "nodeType" && value) {
    if (target.checked) filterState.nodeTypes.add(value);
    else filterState.nodeTypes.delete(value);
    applyGraphFilters();
    void loadStatus();
    return;
  }

  if (group === "edgeType" && value) {
    if (target.checked) filterState.edgeTypes.add(value);
    else filterState.edgeTypes.delete(value);
    applyGraphFilters();
    void loadStatus();
    return;
  }

  if (target.name === "crossLake") {
    filterState.crossLake = target.value || "all";
    applyGraphFilters();
    void loadStatus();
  }
});

async function loadGraph() {
  const data = await gql(
    `query GraphView {
      graphView {
        nodes { id kind label x y external loadedByDefault layer dataJson }
        edges { source target kind layer dataJson }
        meta { totalNodes totalEdges sampledNodes sampledEdges }
      }
    }`,
  );

  const g = data.graphView;
  lastMeta = g.meta || null;
  fullGraph = {
    nodes: g.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      x: n.x,
      y: n.y,
      data: parseDataJson(n.dataJson) ?? n,
    })),
    edges: g.edges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      data: parseDataJson(e.dataJson) ?? {},
    })),
    meta: g.meta,
  };

  renderLegend(fullGraph);
  renderFilters(fullGraph);
  applyGraphFilters();
}

async function loadStatus() {
  const res = await fetch("/api/status");
  const s = await res.json();
  const sampled =
    lastMeta && (lastMeta.sampledNodes || lastMeta.sampledEdges)
      ? ` · render ${lastRenderCounts.nodes}/${lastMeta.totalNodes} nodes ${lastRenderCounts.edges}/${lastMeta.totalEdges} edges`
      : "";
  const sourceMode = s.localSourceMode ? ` · source ${s.localSourceMode}` : "";
  const sync = s.localSync?.lastSuccessfulAt ? ` · synced ${new Date(s.localSync.lastSuccessfulAt).toLocaleTimeString()}` : "";
  statusEl.textContent = `nodes ${s.nodes} · edges ${s.edges} · seeds ${s.seeds} · frontier ${s.weaver.frontier} · inflight ${s.weaver.inFlight}${sourceMode}${sync}${sampled}`;
}

function bindRange(input, labelEl, format = (v) => String(v)) {
  const sync = () => {
    labelEl.textContent = format(Number(input.value));
  };
  input.addEventListener("input", sync);
  sync();
  return sync;
}

async function loadConfigIntoControls() {
  const data = await gql(
    `query Config {
      config {
        render { maxRenderNodes maxRenderEdges }
        weaver {
          ants dispatchIntervalMs maxConcurrency perHostMinIntervalMs revisitAfterMs
          alpha beta evaporation deposit requestTimeoutMs
        }
        scan { maxFileBytes rescanIntervalMs }
      }
    }`,
  );

  const cfg = data.config;

  ui.renderNodes.value = String(cfg.render.maxRenderNodes);
  ui.renderEdges.value = String(cfg.render.maxRenderEdges);

  ui.ants.value = String(cfg.weaver.ants);
  ui.dispatch.value = String(Math.round(cfg.weaver.dispatchIntervalMs / 1000));
  ui.concurrency.value = String(cfg.weaver.maxConcurrency);
  ui.perHost.value = String(Math.round(cfg.weaver.perHostMinIntervalMs / 1000));
  ui.revisit.value = String(Math.round(cfg.weaver.revisitAfterMs / (1000 * 60 * 60)));

  ui.rescan.value = String(Math.round(cfg.scan.rescanIntervalMs / (1000 * 60)));

  bindRange(ui.renderNodes, ui.vRenderNodes, (v) => v.toLocaleString());
  bindRange(ui.renderEdges, ui.vRenderEdges, (v) => v.toLocaleString());
  bindRange(ui.ants, ui.vAnts);
  bindRange(ui.dispatch, ui.vDispatch, (v) => `${v}s`);
  bindRange(ui.concurrency, ui.vConcurrency);
  bindRange(ui.perHost, ui.vPerHost, (v) => `${v}s`);
  bindRange(ui.revisit, ui.vRevisit, (v) => `${v}h`);
  bindRange(ui.rescan, ui.vRescan, (v) => `${v}m`);
}

async function applyControls() {
  const patch = {
    render: {
      maxRenderNodes: Number(ui.renderNodes.value),
      maxRenderEdges: Number(ui.renderEdges.value),
    },
    weaver: {
      ants: Number(ui.ants.value),
      dispatchIntervalMs: Number(ui.dispatch.value) * 1000,
      maxConcurrency: Number(ui.concurrency.value),
      perHostMinIntervalMs: Number(ui.perHost.value) * 1000,
      revisitAfterMs: Number(ui.revisit.value) * 60 * 60 * 1000,
    },
    scan: {
      rescanIntervalMs: Number(ui.rescan.value) * 60 * 1000,
    },
  };

  await gql(
    `mutation Update($patch: ConfigPatchInput!) {
      configUpdate(patch: $patch) {
        render { maxRenderNodes maxRenderEdges }
        weaver { ants dispatchIntervalMs maxConcurrency perHostMinIntervalMs revisitAfterMs }
        scan { rescanIntervalMs }
      }
    }`,
    { patch },
  );
}

// --- node inspector

let selectedNodeId = null;
let selectionSeq = 0;
const nodePaneCache = new Map();

nodeEl.addEventListener("click", (ev) => {
  const target = ev.target.closest?.("[data-nodeid]");
  if (!target) return;
  const nodeId = target.getAttribute("data-nodeid");
  if (!nodeId) return;
  ev.preventDefault();
  void selectNodeById(nodeId);
});

function renderNodeLoading(id) {
  const quick = lastGraphNodesById.get(id);
  const label = quick?.label || shortNode(id) || id;
  nodeEl.innerHTML = `
    <div class="nodeHeader">
      <div class="nodeTitle">${escapeHtml(label)}</div>
      <div class="nodeMeta">${escapeHtml(id)}</div>
      <div class="badges"><span class="badge">loading…</span></div>
    </div>
    <div class="nodeEmpty">fetching preview…</div>
  `;
}

function edgeChipHtml(edge, label) {
  return `<a class="chip" href="#" data-nodeid="${escapeAttr(edge.target)}"><span class="k">${escapeHtml(edge.kind)}</span><span>${escapeHtml(label)}</span></a>`;
}

function renderCodeHtml(code, language) {
  const cls = language ? `language-${language}` : "";
  return `<pre><code class="${cls}">${escapeHtml(code || "")}</code></pre>`;
}

function renderNodePane(pane) {
  const node = pane.node;
  const edges = pane.edges || [];
  const preview = pane.nodePreview;

  if (!node) {
    nodeEl.innerHTML = `<div class="nodeEmpty">node not found</div>`;
    return;
  }

  const nodeData = parseDataJson(node.dataJson) ?? null;
  const lake = inferLake({ ...node, data: nodeData || {} });
  const nodeType = inferNodeType({ ...node, data: nodeData || {} });

  const badges = [
    `<span class="badge">${escapeHtml(lake)}</span>`,
    `<span class="badge">${escapeHtml(nodeType)}</span>`,
    `<span class="badge">${escapeHtml(node.kind)}</span>`,
    node.external ? `<span class="badge">external</span>` : "",
  ].join("");

  const actions = [];
  if (node.kind === "url") {
    const url = nodeData?.url || node.label || node.id.slice("url:".length);
    actions.push(`<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">open url</a>`);
  }

  const relationSections = Object.entries(
    edges.reduce((acc, edge) => {
      const key = edge.kind || "relation";
      acc[key] = acc[key] || [];
      acc[key].push(edge);
      return acc;
    }, {}),
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, rows]) => `
      <div class="nodeSectionTitle">${escapeHtml(kind)}</div>
      <div class="chips">
        ${rows
          .slice(0, 200)
          .map((edge) => {
            const d = parseDataJson(edge.dataJson) || {};
            const spec = typeof d.spec === "string" ? d.spec : "";
            const label = spec ? `${spec} → ${shortNode(edge.target)}` : shortNode(edge.target);
            return edgeChipHtml(edge, label);
          })
          .join("\n")}
      </div>
    `)
    .join("\n");

  let bodyHtml = "";
  let previewBadge = "";

  if (!preview) {
    bodyHtml = `<div class="nodeEmpty">no preview available</div>`;
  } else if (preview.format === "binary") {
    bodyHtml = `<div class="nodeEmpty">binary (${escapeHtml(preview.contentType || "application/octet-stream")})</div>`;
    previewBadge = `<span class="badge">binary</span>`;
  } else if (preview.format === "error") {
    bodyHtml = renderCodeHtml(preview.body || preview.error || "error", "text");
    previewBadge = `<span class="badge">error</span>`;
  } else if (preview.format === "markdown") {
    bodyHtml = `<div class="nodeBody">${markdownToHtml(preview.body || "")}</div>`;
    previewBadge = `<span class="badge">markdown</span>`;
  } else if (preview.format === "html") {
    const baseUrl = nodeData?.url || node.label;
    const md = htmlToMarkdown(preview.body || "", baseUrl);
    bodyHtml = `<div class="nodeBody">${markdownToHtml(md)}</div>`;
    previewBadge = `<span class="badge">web → md</span>`;
  } else {
    // code/text
    bodyHtml = `<div class="nodeBody">${renderCodeHtml(preview.body || "", preview.language || null)}</div>`;
    previewBadge = `<span class="badge">${escapeHtml(preview.language || "code")}</span>`;
  }

  const truncBadge = preview && preview.truncated ? `<span class="badge">truncated</span>` : "";
  const statusBadge = preview && typeof preview.status === "number" ? `<span class="badge">HTTP ${preview.status}</span>` : "";

  const raw = {
    node,
    nodeData,
    preview,
    edges: edges.slice(0, 30),
  };

  nodeEl.innerHTML = `
    <div class="nodeHeader">
      <div class="nodeTitle">${escapeHtml(node.label || node.id)}</div>
      <div class="nodeMeta">${escapeHtml(node.id)}</div>
      <div class="badges">${badges}${previewBadge}${statusBadge}${truncBadge}</div>
    </div>

    ${actions.length ? `<div class="nodeActions">${actions.join("\n")}</div>` : ""}

    ${relationSections}

    ${bodyHtml}

    <div class="nodeBody">
      <details>
        <summary>raw</summary>
        ${renderCodeHtml(safeJson(raw), "json")}
      </details>
    </div>
  `;

  highlightAll(nodeEl);
}

async function loadNodePane(id) {
  return await gql(
    `query NodePane($id: ID!, $max: Int!) {
      node(id: $id) { id kind label external loadedByDefault layer dataJson }
      edges(source: $id, limit: 800) { id kind target layer dataJson }
      nodePreview(id: $id, maxBytes: $max) { id kind format contentType language body truncated bytes status error }
    }`,
    { id, max: 200_000 },
  );
}

async function selectNodeById(id) {
  selectedNodeId = id;
  view.setSelectedNode(id);

  const seq = ++selectionSeq;
  renderNodeLoading(id);

  try {
    let pane = nodePaneCache.get(id);
    if (!pane) {
      pane = await loadNodePane(id);
      nodePaneCache.set(id, pane);
    }
    if (seq !== selectionSeq) return;
    renderNodePane(pane);
  } catch (err) {
    if (seq !== selectionSeq) return;
    const message = err instanceof Error ? err.message : String(err);
    nodeEl.innerHTML = `<div class="nodeEmpty">${escapeHtml(message)}</div>`;
  }
}

// --- buttons

fitBtn.addEventListener("click", () => view.fitToGraph());
reloadBtn.addEventListener("click", async () => {
  nodePaneCache.clear();
  await loadGraph();
  await loadStatus();
  if (selectedNodeId) void selectNodeById(selectedNodeId);
});
applyBtn.addEventListener("click", async () => {
  applyBtn.disabled = true;
  try {
    await applyControls();
    nodePaneCache.clear();
    await loadGraph();
    await loadStatus();
    if (selectedNodeId) void selectNodeById(selectedNodeId);
  } finally {
    applyBtn.disabled = false;
  }
});
rescanNowBtn.addEventListener("click", async () => {
  rescanNowBtn.disabled = true;
  try {
    await gql(
      `mutation Rescan {
        rescanNow { nodes edges seeds }
      }`,
    );
    nodePaneCache.clear();
    await loadGraph();
    await loadStatus();
    if (selectedNodeId) void selectNodeById(selectedNodeId);
  } finally {
    rescanNowBtn.disabled = false;
  }
});

await loadConfigIntoControls();
await loadGraph();
view.fitToGraph();
await loadStatus();

const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = async () => {
  nodePaneCache.clear();
  await loadGraph();
  await loadStatus();
  if (selectedNodeId) void selectNodeById(selectedNodeId);
};
