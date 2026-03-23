# Custom Compute — Design Spec

**Date:** 2026-03-22
**Status:** Draft

## Overview

Custom Compute lets InsForge users deploy their own Docker containers alongside InsForge's managed services (database, auth, storage, AI). The container gets a URL, auto-injected InsForge credentials, and runs on AWS ECS Fargate.

**Positioning:** "Bring the code you already have. InsForge runs it and gives it superpowers — a database, auth, storage, and AI out of the box."

**Target users:**

- Developers who need logic that doesn't fit edge functions (ML models, complex processing, non-JS languages)
- Developers with existing backends who want to adopt InsForge incrementally (modular on-ramp)

## Phase 1 Scope

- One container per project
- Always-on, HTTP-serving
- GitHub-connected with auto-build (Nixpacks + Dockerfile support)
- Pre-built image support as alternative
- Custom env vars + auto-injected InsForge credentials
- Default subdomain (`compute.{project}.insforge.app`)

## Phase 2 (Future)

- Multiple containers per project (path/subdomain routing)
- Custom domains with auto-SSL
- Resource tiers (CPU/memory selection in dashboard)
- Event triggers (cron, DB changes, webhooks)
- Long-running services
- ECS on EC2 capacity providers (cost optimization at scale)

## Architecture

### Self-Hosted (Phase 1)

The InsForge open-source backend gets a new `compute` module that talks to AWS directly using credentials the self-hosted user provides.

```
┌─────────────────────────────────┐
│  InsForge (self-hosted EC2)     │
│                                 │
│  Backend ──── AWS SDK ──────────────→  AWS (ECS, ALB,
│  (compute module)               │      CodeBuild, ECR,
│                                 │      Route53)
│  Dashboard                      │
│  (compute UI)                   │
└─────────────────────────────────┘
```

### Cloud Version (Future)

Same compute module, different provider. The backend calls the InsForge Cloud Control Plane instead of AWS directly.

```
┌─────────────────────────────────┐
│  InsForge (managed)             │
│                                 │
│  Backend ──── API call ─────────────→  InsForge Cloud
│  (same compute module,          │      Control Plane
│   different provider)           │          │
│                                 │          ↓
│                                 │      AWS (ECS, etc.)
└─────────────────────────────────┘
```

### Shared AWS Infrastructure (provisioned once)

Set up once before any customer deploys. Done via CDK, Terraform, or manually:

- ECS Cluster (empty)
- ALB + HTTPS listener with wildcard cert (`*.compute.insforge.app`)
- ECR registry
- CodeBuild project
- VPC / subnets / security groups
- Route53 wildcard record (`*.compute.insforge.app` → ALB)

### Request Flow

```
User's browser/client
        ↓
compute.myproject.insforge.app
        ↓
ALB (host-based routing rule)
        ↓
Target Group → Fargate Task (customer's container)
        ↓
Container handles request, can connect to:
  - InsForge Postgres (via connection string env var)
  - InsForge API (via base URL + anon key env vars)
  - Any external service
```

## Data Model

### `compute.containers`

```sql
CREATE TABLE compute.containers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id),
  name              TEXT NOT NULL DEFAULT 'default',

  -- Source (one of these is set)
  source_type       TEXT NOT NULL CHECK (source_type IN ('github', 'image')),
  github_repo       TEXT,
  github_branch     TEXT,
  image_url         TEXT,
  dockerfile_path   TEXT DEFAULT './Dockerfile',

  -- Runtime config
  cpu               INTEGER NOT NULL DEFAULT 256,
  memory            INTEGER NOT NULL DEFAULT 512,
  port              INTEGER NOT NULL DEFAULT 8080,
  health_check_path TEXT DEFAULT '/health',
  env_vars          JSONB DEFAULT '{}',

  -- State
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'building', 'deploying',
                           'running', 'stopped', 'failed')),
  endpoint_url      TEXT,

  -- AWS references
  ecs_service_arn   TEXT,
  ecs_task_def_arn  TEXT,
  target_group_arn  TEXT,
  alb_rule_arn      TEXT,

  -- Scaling (future)
  replicas          INTEGER DEFAULT 1,

  -- Auto-deploy
  auto_deploy       BOOLEAN DEFAULT true,
  github_webhook_id TEXT,

  -- Custom domains (future)
  custom_domain     TEXT,

  -- Region (future multi-region)
  region            TEXT DEFAULT 'us-east-1',

  -- Metadata
  last_deployed_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
```

### `compute.deployments`

```sql
CREATE TABLE compute.deployments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id  UUID NOT NULL REFERENCES compute.containers(id),

  commit_sha    TEXT,
  image_tag     TEXT,
  build_log_url TEXT,

  status        TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'building', 'pushing',
                     'deploying', 'live', 'failed')),
  error_message TEXT,

  -- Trigger tracking
  triggered_by  TEXT DEFAULT 'manual'
                CHECK (triggered_by IN ('manual', 'git_push',
                       'rollback', 'config_change', 'cron')),

  -- Rollback support
  is_active     BOOLEAN DEFAULT false,

  started_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
```

### `compute.log_streams`

```sql
CREATE TABLE compute.log_streams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id  UUID NOT NULL REFERENCES compute.containers(id),
  log_type      TEXT CHECK (log_type IN ('build', 'runtime')),
  log_ref       TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

## Backend API Routes

### Container Management

| Method   | Route                       | Description                          |
| -------- | --------------------------- | ------------------------------------ |
| `POST`   | `/compute/containers`       | Create a container config            |
| `GET`    | `/compute/containers`       | List containers for project          |
| `GET`    | `/compute/containers/:id`   | Get container details + status       |
| `PATCH`  | `/compute/containers/:id`   | Update config (env vars, resources)  |
| `DELETE` | `/compute/containers/:id`   | Stop and remove container            |

### Deployment

| Method   | Route                                       | Description                   |
| -------- | ------------------------------------------- | ----------------------------- |
| `POST`   | `/compute/containers/:id/deploy`            | Trigger a deployment          |
| `GET`    | `/compute/containers/:id/deployments`       | List deployment history       |
| `GET`    | `/compute/containers/:id/deployments/:did`  | Get deployment details        |
| `POST`   | `/compute/containers/:id/rollback/:did`     | Rollback to previous deploy   |

### Logs

| Method | Route                                              | Description     |
| ------ | -------------------------------------------------- | --------------- |
| `GET`  | `/compute/containers/:id/logs`                     | Get runtime logs |
| `GET`  | `/compute/containers/:id/deployments/:did/build-log` | Get build log  |

### GitHub Integration

| Method | Route                        | Description                       |
| ------ | ---------------------------- | --------------------------------- |
| `POST` | `/compute/github/connect`    | OAuth flow to connect GitHub      |
| `GET`  | `/compute/github/repos`      | List user's repos                 |
| `POST` | `/compute/github/webhook`    | Incoming webhook for auto-deploy  |

### Provider Abstraction

```typescript
interface ComputeProvider {
  // Build
  buildImage(params: BuildParams): Promise<BuildResult>

  // Container lifecycle
  deploy(params: DeployParams): Promise<DeployResult>
  stop(containerId: string): Promise<void>
  destroy(containerId: string): Promise<void>

  // Status
  getStatus(containerId: string): Promise<ContainerStatus>
  getLogs(containerId: string, opts: LogOpts): Promise<LogStream>

  // Routing
  createRoute(params: RouteParams): Promise<RouteResult>
  deleteRoute(containerId: string): Promise<void>
}
```

Two implementations:

- `AwsFargateProvider` — Phase 1, self-hosted users with AWS credentials
- `InsForgeCloudProvider` — Future, calls InsForge Cloud Control Plane API

Swapping is a config change:

```typescript
const provider = config.computeProvider === 'insforge_cloud'
  ? new InsForgeCloudProvider(config)
  : new AwsFargateProvider(config)
```

## Deploy Pipeline

### GitHub Source Flow

```
1. CLONE
   CodeBuild clones repo from GitHub (branch specified)

2. DETECT
   Dockerfile exists?
   ├── Yes → use it directly
   └── No  → Nixpacks detects runtime, generates Dockerfile

3. BUILD
   CodeBuild runs docker build
   Status: building

4. PUSH
   Push image to ECR
   Tag: {project-id}/{container-name}:{commit-sha}
   Status: pushing

5. REGISTER
   Create ECS Task Definition:
   - Image: ECR image URI
   - CPU/Memory from container config
   - Port mapping
   - Env vars (auto-injected + user-defined)

6. ROUTE (first deploy only)
   - Create Target Group (port, health check path)
   - Create ALB Listener Rule (host header match)
   - (No Route53 step — wildcard DNS already covers it)

7. DEPLOY
   Create or Update ECS Service:
   - Cluster: insforge-compute
   - Task definition: from step 5
   - Desired count: 1
   - Deployment circuit breaker: enabled
   Status: deploying

8. HEALTHY
   ECS health checks against health_check_path
   ├── Pass → Status: running, mark deployment as live
   └── Fail → Status: failed, circuit breaker rolls back
```

### Pre-built Image Flow

Skips steps 1-4. Starts at step 5 with the user-provided image URL.

### Auto-Deploy on Git Push

```
GitHub webhook fires (push to tracked branch)
        ↓
POST /compute/github/webhook
        ↓
Backend verifies webhook signature
        ↓
Finds container with matching repo + branch
        ↓
auto_deploy === true?
├── Yes → triggers full deploy flow
└── No  → ignore
```

### Rollback

Fetches previous deployment's image tag, skips build, goes straight to step 5. Fast redeploy (~30 seconds).

### Concurrent Deploy Protection

If a container has a deployment with status IN (`building`, `pushing`, `deploying`), reject new deploys with "deployment already in progress."

### Error Handling

| Failure Point       | Behavior                                                         |
| ------------------- | ---------------------------------------------------------------- |
| Clone fails         | Status: failed, log "repo not found or no access"                |
| Build fails         | Status: failed, build log saved, previous deployment stays live  |
| Health check fails  | Status: failed, ECS circuit breaker rolls back automatically     |
| Deploy timeout (10m)| Status: failed, clean up partial resources                       |

## Configuration

### AWS Credentials (self-hosted)

New env vars in the InsForge `.env`:

```bash
# Feature toggle
COMPUTE_ENABLED=true
COMPUTE_PROVIDER=aws_fargate

# AWS credentials
COMPUTE_AWS_ACCESS_KEY_ID=AKIA...
COMPUTE_AWS_SECRET_ACCESS_KEY=...
COMPUTE_AWS_REGION=us-east-1

# Shared infra references (from one-time setup)
COMPUTE_ECS_CLUSTER_ARN=arn:aws:ecs:...
COMPUTE_ALB_LISTENER_ARN=arn:aws:ecs:...
COMPUTE_ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com
COMPUTE_CODEBUILD_PROJECT=insforge-compute-builder
COMPUTE_SUBNET_IDS=subnet-abc,subnet-def
COMPUTE_SECURITY_GROUP_ID=sg-123
COMPUTE_DOMAIN=compute.insforge.app
```

**Networking requirement:** `COMPUTE_SUBNET_IDS` and `COMPUTE_SECURITY_GROUP_ID` must be in the same VPC as the InsForge EC2 instance, so the Fargate container can reach the InsForge Postgres.

### Auto-Injected Into Customer Containers

```bash
INSFORGE_DB_URL=postgresql://user:pass@host:5432/db
INSFORGE_BASE_URL=https://project.region.insforge.app
INSFORGE_ANON_KEY=eyJ...
PORT=8080
```

### User-Defined Env Vars

Set via dashboard, stored encrypted in `compute.containers.env_vars`. Merged at deploy time. User-defined cannot override auto-injected vars.

### Container Contract

The only requirements for the customer's container:

1. Listen on `$PORT` (default 8080)
2. Respond to `GET {health_check_path}` with 200 (default `/health`)

Any language, any framework, any dependencies.

## Dashboard UI

### Container List View (`/compute`)

Lists all containers for the project. Phase 1 shows one container; Phase 2 shows multiple. Each card shows: name, source repo, endpoint URL, status, resource allocation, last deploy time.

Primary action: **[+ Deploy]** button opens deploy modal.

### Deploy Modal

Two source modes:

- **GitHub repo**: Select repo, branch, Dockerfile path (or auto-detect with Nixpacks), port, health check path
- **Image URL**: Paste image URL, port, health check path

### Container Detail View (`/compute/:id`)

Three tabs:

- **Overview**: Status, endpoint URL, source config, resource allocation, actions (Redeploy, Stop, Delete)
- **Env Vars**: Auto-injected (read-only) and user-defined (editable). Save triggers redeploy.
- **Deployments**: Chronological list of all deploys with status, trigger type, commit SHA, timing. Each entry has View Log and Rollback (for non-active deploys) actions.

### Build Log View

Slide-out panel showing streaming build output: clone → detect → install → build → push → deploy → health check result.

## Infrastructure Scaling Path

| Stage                | When              | Migration Effort       |
| -------------------- | ----------------- | ---------------------- |
| ECS Fargate          | Now, < 100 containers | —                  |
| ECS on EC2           | 100-500 containers | Near zero (add capacity providers) |
| EKS                  | 500+ or need K8s features | Significant (K8s manifests) |

Fargate → ECS on EC2 is a config change, same API. EKS is the big jump, only justified for GPU workloads, service mesh, or complex multi-container networking.

## Pricing Model

| Tier     | Resources          | Suggested Price |
| -------- | ------------------ | --------------- |
| Starter  | 0.25 vCPU, 0.5 GB | $15/month       |
| Pro      | 0.5 vCPU, 1 GB    | $30/month       |
| Business | 1 vCPU, 2 GB      | $50/month       |

AWS Fargate cost for Starter tier: ~$9/month. Margin: ~$6/container.
