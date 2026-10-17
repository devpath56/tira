# Plane (plane.so) — Data Model & Feature Findings from Official Docs

Research date: 2026-10-16. Sources are exclusively official Plane documentation: product docs at `docs.plane.so` (and Plane's official docs repo `makeplane/docs`, which publishes the same content) and developer docs at `developers.plane.so` (mirrored in Plane's official `makeplane/developer-docs` repo). Claims drawn from third-party sources are labeled as such and treated as leads, not evidence. Anything not confirmed in official docs is flagged **UNVERIFIED**.

API base (context for §8): base URL `https://api.plane.so/`, path prefix `/api/v1/`. Auth: `X-API-Key` header or OAuth `Authorization: Bearer`. Cursor-based pagination (`per_page` max 100, `next_cursor`/`prev_cursor`). Rate limit 60 req/min per key. `fields` and `expand` query params for selective/nested retrieval. (Source: `developers.plane.so/api-reference/introduction`; OAuth scopes: `makeplane/developer-docs` → `docs/dev-tools/build-plane-app/oauth-scopes.md`.)

---

## 1. ISSUE DATA MODEL

**Work item fields** (source: `developers.plane.so/api-reference/issue/overview`, "The Work Item object"):
`name` (required), `description_html`, `description_stripped`, `description_binary`, `priority` (enum: none/urgent/high/medium/low), `state` (UUID of a project state), `assignees` (UUID[]), `labels` (UUID[]), `estimate_point` (integer 0–7), `start_date`, `target_date`, `sequence_id` (system-generated; human key is `{project.identifier}-{sequence_id}`, e.g. `WEB-143`), `sort_order` (decimal, system-generated, used for ordering), `parent` (UUID of parent work item, must be in the same workspace), `type`/`type_id` (work item type UUID), `module` (UUID), `is_draft` (boolean), `completed_at` (set when moved to any completed-group state), `archived_at`, `created_at`/`updated_at`, `created_by`/`updated_by`. The create endpoint also accepts `point`, `external_source`, `external_id`, `is_draft`. (Sources: `developers.plane.so/api-reference/issue/add-issue`, `.../issue/overview`.)

**Custom properties**: Yes. Workspace Admins define custom properties at the workspace level and attach them to work item types (source: `docs.plane.so/work-items/workspace-work-item-types`). Property types: Text (single-line / paragraph / read-only), Number, Dropdown (single/multi-select, nestable options), Boolean, Date, Member picker (single/multi; picked members auto-subscribed), Release picker (Business), Rich text (Business; versioned and searchable per the docs), URL, Formula (Enterprise Grid), Cascading (2–4 linked dropdown levels). A property can be marked **Mandatory** — the docs state the work item "cannot be created or saved" without a value (Boolean, Formula, and read-only Text cannot be mandatory). Properties can be overridden per context (project × type). Property title cannot reuse reserved field names: state, due date, cycle, modules.

**Parent/child hierarchy (sub-work items)**: Yes. A work item has a `parent` field pointing at another work item's UUID (same workspace). A sub-work item may sit in a different project than its parent (source: `docs.plane.so/work-items/overview`, "How work items connect"). On Enterprise Grid, workspace Admins can define numbered **hierarchy levels** over work item types (Level 0 = leaf default); once configured, sub-work items can only be created from the level directly below the parent's level, type changes that would break existing parent/child links are blocked, and invalid nesting is prevented across UI, bulk operations, and imports (source: `docs.plane.so/work-items/workspace-work-item-types`, "Hierarchy"). **Max depth: UNVERIFIED** — no stated limit found in official docs; hierarchy levels constrain *type* nesting, not raw depth, and no numeric cap is documented.

**Ordering**: The API exposes `sort_order`, described as "auto generated from the system during creation used for ordering" (source: `.../issue/overview`). In the product, layouts offer Order by: **Manual**, Last Created, Last Updated, Start Date, Due Date, Priority (source: `docs.plane.so/core-concepts/issues/display-options`).

---

## 2. WORKFLOW / STATES

**States**: Each project defines its own states; every state belongs to one of five groups — Backlog, Unstarted, Started, Completed, Cancelled (defaults: Backlog, Todo, In Progress, Done, Cancelled). The *group*, not the name, drives behavior: only Completed-group states count as done (progress, burndown, analytics); only Completed/Cancelled states are eligible for auto-archiving; only Completed sets `completed_at`. States sort by group first, then position. (Source: `docs.plane.so/core-concepts/issues/states`.) The API state object also exposes a `triage` group value and `is_triage` flag (source: `developers.plane.so/api-reference/state/overview` and `makeplane/developer-docs` → `docs/api-reference/state/add-state.md`) — the product docs describe five groups; `triage` appears only in API docs.

**Transition guarding**: Yes, and it is enforced. Workflows define which state changes are permitted. Members can only move work items along defined transitions; attempting a disallowed change shows a blocker message. Each state has an **"Allow new work items"** toggle (states reachable only via progression can forbid direct creation). Every project has one default workflow. (Source: `docs.plane.so/workflows-and-approvals/workflows`.)

**Who can transition**: Flows carry a **by** setting (All members or specific members) restricting who may execute them. (Same source.)

**Per-transition validation**: On Enterprise Grid, transitions can carry **conditions** implemented as pre-validation scripts ("Workflow Transition" type) run via Plane Runner; a failing script blocks the transition. Documented examples: verifying required fields are filled, an estimate exists, or all sub-work items are completed. **Post-actions** (scripts running after a transition) can also be attached, e.g. notifications, comments, property updates, external API calls. Approval flows, transition conditions, and multiple type-scoped custom workflows are Enterprise Grid only; Business plans get the single default workflow. (Same source.)

---

## 3. RELATIONS

**Types** (source: `developers.plane.so/api-reference/work-item-relations/overview`): `blocking`, `blocked_by`, `duplicate`, `relates_to`, `start_after`, `start_before`, `finish_after`, `finish_before`. Enterprise Grid adds workspace-level **custom relation types** with directional inward/outward names (e.g. "Tests" / "tested by" / "tests") (source: `makeplane/docs` → `docs/work-items/custom-relations.md`).

**Semantics — labels vs enforcement**: The product docs draw an explicit line (source: `docs.plane.so/work-items/overview`, "How work items connect"): **Relations don't affect dates**; **Dependencies affect scheduling** — blocking and the start/finish before/after types are shown in the Relations section and drive the Timeline layout. So relations are informational links for some types and scheduling constraints for the dependency types. **No official doc found stating that a relation (e.g. `blocked_by`) gates a state transition** — the documented transition blockers are workflow flows, approvals, and pre-validation scripts (§2). Treat "relations enforce transitions" as **UNVERIFIED**. The API docs describe relation types only as modeling "dependencies and planning constraints" with no behavioral guarantees beyond that.

---

## 4. REQUIRED FIELDS / VALIDATION

- **Mandatory custom properties** (Enterprise Grid): a Workspace Admin can mark a property mandatory; the work item cannot be created or saved without it. Mandatory settings can vary per context (e.g. mandatory on Bug in one project, optional in another). Existing items missing the value must fill it on next edit. (Source: `docs.plane.so/work-items/workspace-work-item-types`, "Property settings".)
- **Per-transition validation** (Enterprise Grid): pre-validation scripts on workflow transitions can block the move (examples given: required fields filled, estimate exists, sub-work items complete). (Source: `docs.plane.so/workflows-and-approvals/workflows`.)
- **No explicit "require an attachment before entering state X" feature found** in official docs — UNVERIFIED as a first-class capability (a Runner script could presumably check for attachments, but no doc confirms this pattern).
- On non-Enterprise plans, the only required-field mechanism documented is the workflow's own transition/approval restrictions — required *fields* at creation via mandatory properties are Enterprise Grid (workspace work item types are an Enterprise Grid feature). The Business plan has one default workflow with transition flows but the docs gate transition *conditions* (scripts) to Enterprise Grid.

---

## 5. HISTORY / ACTIVITY

**Per-work-item activity log**: Yes. The API docs define work item activity as "the history of all changes made to a work item, including property changes, comments, and other modifications" (source: `developers.plane.so/api-reference/issue-activity/overview`). The activity object carries: `id`, `created_at`, `updated_at`, `deleted_at` (nullable), `verb` (created/updated), `field`, `old_value`, `new_value`, auto-generated `comment` text, `attachments`, `old_identifier`/`new_identifier`, `epoch`, `project`, `workspace`, `issue`, `issue_comment` (the comment UUID when activity stems from a comment), and `actor` (who triggered it). (Same source.)

**Immutability**: The product docs state explicitly that in the work item activity panel, "activity is system-written and immutable; comments are user-written and editable" (source: `makeplane/docs` → `docs/communication-and-collaboration/comments-and-activity.md`). Nuance: the activity object schema includes a `deleted_at` field ("timestamp when the activity was deleted (if deleted)"), and Plane's official OAuth scope list includes `projects.work_items.activities:write` described as "Create and update work item activities" (source: `makeplane/developer-docs` → `docs/dev-tools/build-plane-app/oauth-scopes.md`). No create/update/delete activity *endpoint* page was found in the public API reference (only list + get). So: append-only in the product UI; whether entries can be mutated via API is **partially UNVERIFIED** (scope exists; endpoint not documented in the API reference).

**Workspace-level audit log**: Yes. The workspace audit log (Settings → Audit logs) records sign-ins, membership/role changes, settings changes, integration activity, and security events. It is **append-only and tamper-evident**; entries are written once and can never be edited or deleted by anyone, including admins. Visible/exportable only to workspace Admins and Owners. It is an **Enterprise Grid** feature. (Source: `makeplane/docs` → `docs/workspaces-and-users/audit-logs.md`.)

---

## 6. EVIDENCE: ATTACHMENTS & COMMENTS

**Attachments**: Files attach to work items (also to comments, pages, and draft work items — the attachment object has `comment`, `page`, and `draft_issue` link fields). Upload is a 3-step API flow: (1) POST `.../work-items/{id}/attachments/` with name/type/size to get upload credentials (presigned URL), (2) upload the file to storage, (3) complete the upload to notify the server (source: `developers.plane.so/api-reference/issue-attachments/overview`). The attachment object records name, size, MIME type, storage path, `is_uploaded`, storage metadata (ETag, content type), `created_by`/`updated_by`/`deleted_by`, `is_deleted`, `is_archived`, and `external_id`/`external_source` for imports. **Attachments are not required by any documented mechanism; no versioning of attachments was found in the docs** (no version field; the object tracks only created/updated/deleted timestamps) — treat versioning as UNVERIFIED. Deleting a work item also deletes its attachments (source: `docs.plane.so/work-items/create-and-manage-work-items`).

**Comments**: Threaded, rich-text comments on work items (bold/italic/code/lists/headings/quotes/code blocks/links, embedded images). They appear in the work item's activity panel alongside system activity events but are distinct: user-written and **editable** (and deletable — webhooks fire `workitem.comment.created/updated/deleted`). (Sources: `makeplane/docs` → `docs/communication-and-collaboration/comments-and-activity.md`; webhook events at `developers.plane.so/dev-tools/intro-webhooks`.)

---

## 7. DRAFTS / APPROVALS

- **Drafts**: Yes. Closing the work-item create modal offers "Save this draft"; drafts are private to the user until moved into a project (source: `docs.plane.so/work-items/create-and-manage-work-items`). The API has an `is_draft` boolean on work items and a `draft_issue` link on attachments (sources: `developers.plane.so/api-reference/issue/overview`, `.../issue-attachments/overview`).
- **Approval workflows**: Yes — Enterprise Grid. An **Approval** flow type on a workflow state gates the transition: the item enters a pending state, designated approvers see Approve/Reject actions, and the item moves to the configured destination state for each outcome. (Source: `docs.plane.so/workflows-and-approvals/workflows`.)
- **Intake triage as review gate**: Intake items (submissions from outside the project) are triaged with accept / reject / mark-as-duplicate / snooze actions before becoming regular work items (source: `makeplane/developer-docs` → `docs/api-reference/intake-issue/update-intake-issue-detail.md`, statuses: Pending −2, Rejected −1, Snoozed 0, Accepted 1, Duplicate 2).

---

## 8. API ENDPOINTS & WEBHOOKS

Base: `https://api.plane.so/api/v1`. All paths below are under `/api/v1/workspaces/{workspace_slug}/projects/{project_id}/` unless noted.

**Work items**: `POST .../work-items/` (create), `GET .../work-items/` (list), `GET .../work-items/{resource_id}/` (get), `PATCH .../work-items/{resource_id}/` (update), `DELETE` (delete; product doc confirms permanent delete). A workspace-level resolver also exists: `GET /api/v1/workspaces/{slug}/work-items/{project_identifier}-{sequence_id}/` (e.g. `CG-42`). (Sources: `developers.plane.so/api-reference/issue/*`; delete semantics: `docs.plane.so/work-items/create-and-manage-work-items`.)

**States**: `POST .../states/` (create: name + color required; group, description, sequence, default, is_triage, external ids optional), `PATCH .../states/{state_id}/` (update). (Sources: `makeplane/developer-docs` → `docs/api-reference/state/add-state.md`, `.../state/update-state-detail.md`.)

**Relations**: `POST .../work-items/{work_item_id}/relations/` with body `{relation_type, issues[]}`; `GET` the same path returns the per-type grouping (`blocking`, `blocked_by`, `duplicate`, `relates_to`, `start_after`, `start_before`, `finish_after`, `finish_before`). Creating a relation auto-creates the inverse. (Sources: `makeplane/developer-docs` → `docs/api-reference/work-item-relations/create-work-item-relation.md`; `developers.plane.so/api-reference/work-item-relations/overview`.) A remove endpoint (`DELETE .../relations/remove/`) is cited only by third-party sources — **UNVERIFIED in official docs** — though the official OAuth scopes include `projects.work_items.relations:write` ("Create and update work item relations").

**Activity**: `GET .../work-items/{work_item_id}/activities/` (list; filterable by type and date range) and `GET .../activities/{resource_id}/` (detail). No create/update/delete activity endpoint pages found in the official API reference. (Sources: `developers.plane.so/api-reference/issue-activity/*`.)

**Comments**: The API reference has an `issue-comment` section (`GET .../work-items/{id}/comments/{resource_id}/` confirmed), and OAuth scopes `projects.work_items.comments:read/write` exist ("Read / Create and update work item comments"). (Sources: `developers.plane.so` search index; `makeplane/developer-docs` → oauth-scopes.md.)

**Attachments**: `POST .../work-items/{id}/attachments/` (get upload credentials) + upload-to-storage + complete-upload flow; `GET` list. (Source: `developers.plane.so/api-reference/issue-attachments/*`.)

**Webhooks** (source: `developers.plane.so/dev-tools/intro-webhooks`): v2, **workspace-level** (one webhook covers all projects; no per-project webhooks), managed by Workspace Owners/Admins, HMAC-SHA256 signed (`X-Plane-Signature`), async delivery with exponential-backoff retries (~10-min base), auto-disabled after 5 failed attempts, optional PQL/basic work-item filters. **Event keys**: Work items — `workitem.created`, `workitem.updated`, `workitem.archived`, `workitem.deleted` (note: no dedicated state-change event; state changes arrive as `workitem.updated`, with v2 `previous_attributes` for diffing); Work item comments — `workitem.comment.created/updated/deleted`; plus `workitem.link.*`, `workitem.vote.*`, and project/cycle/module/milestone/page events (`page.comment.created/updated/deleted` included). There is **no `workitem.state_changed` event key** in the documented event reference.

---

## 9. COMPUTED / DERIVED FIELDS & AUTOMATION

- **Formula fields**: Yes (Enterprise Grid custom property type). Computed, read-only; Plane evaluates the expression per work item. Syntax references other properties as `{{field_name}}` (case-insensitive, spaces/underscores equivalent); can reference Text, Number, Date, Boolean properties on the same work item type, not itself. Operators: arithmetic, date arithmetic (difference in days, ± days), text concatenation (`&`), comparisons; functions: `IF`, `ROUND`, `ABS`, `UPPER`, `LOWER`, `LEN`, `CONCAT`, `TODAY()`, `NOW()`. Result types: Number, Text, Date, Boolean. Empty inputs → empty result; runtime errors (e.g. divide by zero) show an error state. Formulas cannot be mandatory. (Source: `docs.plane.so/work-items/workspace-work-item-types`, "Formula".)
- **Parent rollups (% complete from children)**: **UNVERIFIED** — no official doc found describing automatic parent progress rollups from sub-work items. The hierarchy doc mentions keeping "reporting and rollups meaningful" only in passing as motivation, with no feature detail.
- **Automation rules**: Yes. Project automations (Project Settings → Automations): trigger + optional conditions (all must match) + actions, choosing from **Add comment**, **Change property**, or **Run Script**; multiple conditions/actions supported; must be enabled to go live (stays draft until then). Workspace-wide automations are Enterprise Grid. Built-ins: auto-archive closed work items, auto-close stale work items (Backlog/Unstarted/Started → closed state after inactivity), due-date reminders (Business). (Sources: `makeplane/docs` → `docs/automations/custom-automations.md`, `docs/automations/overview.md`.)
- **Plane Runner scripts**: event-based (work item state changes, creation, label added, etc. — receives full event payload incl. previous attributes) and scheduled (cron). Functions are reusable named logic callable from scripts. (Source: `makeplane/docs` → `docs/automations/plane-runner.md`.) Runner scripts also power workflow transition pre-validation/post-actions (§2).

---

## 10. DELETION

(Source for all claims: `docs.plane.so/work-items/create-and-manage-work-items`.)

- **Delete is permanent and unrecoverable**: "Deleting a work item removes it permanently. You can't undo it." Deleting a parent **also deletes all of its sub-work items and attachments** (docs advise removing a sub-work item from the parent first if it should be kept). Permissions: Admins can delete any work item; Contributors can delete only work items they created. The API create/update schemas carry a `deleted_at` field, consistent with a delete marker, but the product doc presents delete as permanent — **whether history/activity survives deletion is UNVERIFIED** (no doc states what happens to the activity trail of a deleted item).
- **Archive is the soft path**: archiving takes a finished item out of active lists without deleting it; archived items keep all their data, stay searchable, and can be restored at any time (restore returns the item with all properties and history). Archived items are read-only (no edit/comment/vote/subscribe) until restored. Only work items in Completed or Cancelled states can be archived. Auto-archive of closed items is available as a project automation.

---

## UNVERIFIED SUMMARY (could not confirm in official docs)

1. Max sub-issue nesting depth — no limit documented.
2. Whether relations (e.g. `blocked_by`) enforce or gate state transitions — docs say relations are informational / scheduling-only; transition gating is documented only via workflows, approvals, and scripts.
3. Attachment versioning — no version field or version-history feature found for attachments (rich-text *property* content is versioned; file attachments are not documented as such).
4. A first-class "require attachment before entering state X" control — no such feature documented (a Runner pre-validation script could be the mechanism, but no doc confirms it).
5. Whether activity entries can be created/edited/deleted via API — product UI says system-written and immutable; an `activities:write` OAuth scope exists but no corresponding endpoint page was found in the API reference.
6. The relations remove endpoint (`DELETE .../relations/remove/`) — cited only by third-party sources.
7. Parent progress rollups (% complete derived from children) — no feature found.
8. What happens to a deleted work item's activity history — not documented.
