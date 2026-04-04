import { WebGLGraphView, rgba } from "/vendor/webgl-graph-view/index.js";

const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const nodeEl = document.getElementById("node");

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

function shortNode(id) {
  if (!id) return "";
  if (id.startsWith("file:")) {
    const rel = id.slice("file:".length);
    return rel.split("/").slice(-1)[0] || rel;
  }
  if (id.startsWith("dep:")) return id.slice("dep:".length);
  if (id.startsWith("url:")) {
    const url = id.slice("url:".length);
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
  onNodeClick: (node) => {
    void selectNodeById(node.id);
  },
  nodeStyle: (node) => {
    const kind = node.kind || "";
    if (kind === "file") return { sizePx: 4.8, color: rgba(0.42, 0.82, 0.98, 0.95) };
    // urls: make them visually distinct from link edges (and from file nodes)
    if (kind === "url") return { sizePx: 5.8, color: rgba(0.96, 0.46, 0.86, 0.96) };
    if (kind === "dep") return { sizePx: 5.0, color: rgba(0.95, 0.75, 0.42, 0.95) };
    return { sizePx: 4.6, color: rgba(0.62, 0.86, 0.9, 0.92) };
  },
  edgeStyle: (edge) => {
    const kind = edge.kind || "";

    // Auto-dim edges when you crank up render edges.
    // (Without this, 100k+ edges becomes a bright wall and hides the nodes.)
    const aMul = edgeAlphaScale;

    // local structural edges
    if (kind === "import") return { color: rgba(0.74, 0.58, 0.98, 0.22 * aMul) }; // violet
    if (kind === "dep") return { color: rgba(0.98, 0.74, 0.36, 0.18 * aMul) }; // amber
    if (kind === "ref") return { color: rgba(0.42, 0.86, 0.98, 0.16 * aMul) }; // cyan (internal md)
    if (kind === "link") return { color: rgba(0.32, 0.9, 0.66, 0.14 * aMul) }; // green (file -> url)

    // web weave edges (url -> url)
    if (kind === "web") return { color: rgba(0.36, 0.94, 0.72, 0.10 * aMul) };

    // user/sim overlay
    if (kind === "user") return { color: rgba(0.98, 0.56, 0.42, 0.18 * aMul) };
    if (kind === "observes") return { color: rgba(1.0, 0.92, 0.58, 0.18 * aMul) };

    return { color: rgba(0.68, 0.78, 0.92, 0.08 * aMul) };
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
  lastRenderCounts = { nodes: g.nodes?.length || 0, edges: g.edges?.length || 0 };
  edgeAlphaScale = edgeAlphaScaleForCount(lastRenderCounts.edges);

  lastGraphNodesById = new Map(g.nodes.map((n) => [n.id, n]));

  const graph = {
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
    })),
    meta: g.meta,
  };

  view.setGraph(graph);
}

async function loadStatus() {
  const data = await gql(
    `query Status {
      status {
        nodes
        edges
        seeds
        weaver { frontier inFlight }
        render { maxRenderNodes maxRenderEdges }
        scan { maxFileBytes rescanIntervalMs }
      }
    }`,
  );

  const s = data.status;
  const sampled =
    lastMeta && (lastMeta.sampledNodes || lastMeta.sampledEdges)
      ? ` · render ${lastRenderCounts.nodes}/${lastMeta.totalNodes} nodes ${lastRenderCounts.edges}/${lastMeta.totalEdges} edges`
      : "";
  statusEl.textContent = `nodes ${s.nodes} · edges ${s.edges} · seeds ${s.seeds} · weaver frontier ${s.weaver.frontier} · inflight ${s.weaver.inFlight}${sampled}`;
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

  const badges = [
    `<span class="badge">${escapeHtml(node.kind)}</span>`,
    `<span class="badge">${escapeHtml(node.layer || "unknown")}</span>`,
    node.external ? `<span class="badge">external</span>` : "",
  ].join("");

  const actions = [];
  if (node.kind === "url") {
    const url = nodeData?.url || node.label || node.id.slice("url:".length);
    actions.push(`<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">open url</a>`);
  }

  const importEdges = node.kind === "file" ? edges.filter((e) => e.kind === "import") : [];
  const depEdges = node.kind === "file" ? edges.filter((e) => e.kind === "dep") : [];

  const importsHtml =
    importEdges.length > 0
      ? `
        <div class="nodeSectionTitle">imports</div>
        <div class="chips">
          ${importEdges
            .slice(0, 200)
            .map((e) => {
              const d = parseDataJson(e.dataJson) || {};
              const spec = typeof d.spec === "string" ? d.spec : "";
              const label = spec ? `${spec} → ${shortNode(e.target)}` : shortNode(e.target);
              return edgeChipHtml(e, label);
            })
            .join("\n")}
        </div>
      `
      : "";

  const depsHtml =
    depEdges.length > 0
      ? `
        <div class="nodeSectionTitle">deps</div>
        <div class="chips">
          ${depEdges
            .slice(0, 200)
            .map((e) => {
              const d = parseDataJson(e.dataJson) || {};
              const spec = typeof d.spec === "string" ? d.spec : "";
              const label = spec || shortNode(e.target);
              return edgeChipHtml(e, label);
            })
            .join("\n")}
        </div>
      `
      : "";

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

    ${importsHtml}
    ${depsHtml}

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
