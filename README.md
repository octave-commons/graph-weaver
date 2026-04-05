# devel-graph-weaver

A small dev service that:

1. builds a graph from a mounted folder (this repo), respecting `.gitignore`
2. shows it in a WebGL graph view
3. passively grows a web graph from discovered external links using an ACO-ish crawler

## Reading order

1. `docs/INDEX.md`
2. `docs/FORK_TALES_SOURCE_MAP.md`
3. `specs/service-surface.md`
4. `specs/graph-layers-and-storage.md`
5. `specs/query-preview-and-mutation.md`

## Run (docker)

```bash
docker compose -f orgs/octave-commons/graph-weaver/compose.yaml up
```

Then open:

- `http://127.0.0.1:8796/`

GraphQL:

- endpoint: `http://127.0.0.1:8796/graphql`
- GraphiQL UI: `http://127.0.0.1:8796/graphiql`

## Env

- `REPO_ROOT` (default: repo root via `git rev-parse`)
- `PORT` (default: `8796`)
- `HOST` (default: `0.0.0.0`)
- `GRAPH_WEAVER_LOCAL_SOURCE` (default: `repo`) — `repo`, `openplanner-graph`, `openplanner-lakes`, or `none`

- `WEAVER_ANTS` (default: `4`)
- `WEAVER_DISPATCH_INTERVAL_MS` (default: `15000`)
- `WEAVER_MAX_CONCURRENCY` (default: `2`)

Optional:

- `GRAPH_WEAVER_ADMIN_TOKEN` — if set, GraphQL mutations require `Authorization: Bearer <token>`
- `STATE_DIR` (default: `.opencode/runtime`) — where config + user-layer graph snapshots are stored
- `GRAPH_WEAVER_WEB_CRAWL_ENABLED` (default: `true`) — set to `false` when Myrmex owns web crawling and this service should remain a local/UI graph workbench
- `OPENPLANNER_BASE_URL` / `OPENPLANNER_API_KEY` — required when `GRAPH_WEAVER_LOCAL_SOURCE=openplanner-graph` or `openplanner-lakes`

## Adjacent repos

- `octave-commons/graph-weaver-aco` — ACO traversal kernel
- `octave-commons/myrmex` — richer extraction/integration orchestrator
