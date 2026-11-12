# State machines

A state machine is any retained state that changes which events are accepted or what they do.
This inventory groups related machines by owner; it includes explicit unions as well as implicit
machines encoded by nullable records, flags, timers, captures and queues. It is a source-level
map, not a proof that every possible runtime combination has been enumerated.

## Decision

Keep state near its owner. Make observable capabilities describe the transition the owner
will actually perform. Do not replace these independent lifecycles with one global machine
or add a state-machine dependency just to rename existing flags.

The first correction is Undo: pending placement, floating content and extrusion cancellation
precede recorded history. `Editor.canUndo` and `Editor.undoLabel` now include those transitions,
and agent tools read the same label as the UI. Editing an existing shape is already recorded
and must retain its history label. `History` itself still describes recorded entries only.
The getter is reactive and read-only; document data, history entries and file formats are unchanged.

## Editing and documents

Paths below are relative to the repository root. States are conceptual, not new API enum values.

| Machine | Owner | States and transition boundary |
| --- | --- | --- |
| Transactions and strokes | `packages/core/src/editor.ts` | Idle / transaction / stroke; end records, cancel reverts. Structural changes must not leave a stroke targeting old cells. |
| Undo and redo | `packages/core/src/history.ts`, `editor.ts` | Pending cancellation precedes undo / redo stacks; new edits invalidate redo; shared inversion may preserve conflicting remote changes. |
| Pointer tool | `packages/core/src/tools.ts` | Idle / gesture variant / finish or cancel; tool-specific rollback belongs to the gesture owner. |
| Shape drawing | `tools.ts` | Footprint / height / completed; pointer release is not always final completion. |
| Shape operand | `packages/core/src/editor-shapes.ts` | No operand / new placement / existing step edit; commit, cancel and end-edit have different history semantics. |
| Path drawing | `editor-shapes.ts` | No path / active path / selected point; finish and cancellation must respect already recorded steps. |
| Floating content | `packages/core/src/editor-floating.ts` | Grounded / lifted or pasted / transformed / applied or cancelled; source hiding is a preview until apply. |
| Extrusion | `packages/core/src/editor-extrusion.ts` | Idle / pending face and depth / apply or cancel; previews must not silently become recorded content. |
| Selection | `packages/core/src/selection.ts`, `editor.ts` | Empty / mask / floating; empty means unrestricted editing, not zero editable cells. |
| Workplane and marker picking | `editor.ts` | Normal editing / armed pick / marker drag; cancel or pointer completion exits capture and restores drag state. |
| Frame playback | `packages/core/src/editor-frames.ts`, `animation.ts` | Paused / playing / frame switch; frame replacement settles pending edits and stops playback. |
| Edit permission | `editor.ts` | Editable / read-only plus hidden, locked and incompatible layer blockers; selection and document mutation have different guards. |
| Evaluation and rendering invalidation | `editor.ts`, `document.ts`, `evaluate.ts` | Clean / invalidated / queued / rebuilt; versioned caches must never be treated as document truth. |
| Library navigation | `packages/core/src/library.ts` | Library / standalone model / scene / model entered through an instance; navigation changes editing and history context. |
| Library history and supplied models | `library.ts` | Idle / transaction or stroke / inversion; supplied-model resolution has resolving and resync guards. |
| Scene interactions | `packages/three/src/scene-layer.ts` | Idle / selected / move or rotate drag / placement; cancellation and completion close the shared history stroke. |

## Input, UI and headset

| Machine | Owner | States and transition boundary |
| --- | --- | --- |
| Canvas ownership | `packages/three/src/viewport.ts` | Idle / tool / orbit / layer interaction / multiple pointers; a second finger cancels the first tool gesture before navigation. |
| Handle drags | `viewport.ts`, `field-handles.ts` | Hover or idle / captured gizmo, shape or workplane handle / release or cancel; hover is optional feedback. |
| Camera | `packages/three/src/camera.ts`, `viewport.ts` | Perspective or orthographic / 2D projection / orbit or pan / view transition. |
| Menus, dialogs and sheets | `packages/sdk/src/primitives.tsx`, `dialogs.tsx`, `properties-sheet.tsx`, `main-menu.tsx` | Closed / open / submenu or dialog; dismissal and focus restoration belong to the surface. |
| Inline editing and dragging | `packages/sdk/src/tree-row.tsx`, `layers-panel.tsx`, `timeline.tsx`, `shape-rows.tsx` | Display / rename or reorder / commit or cancel; document writes go through editor commands. |
| Context bars and commands | `packages/sdk/src/actions.ts`, `selection-bar.tsx`, `shape-bar.tsx`, `extrude-bar.tsx`, `marker-bar.tsx` | Availability is derived from current editor context; do not retain a second copy of core capabilities. |
| File and export workflows | `packages/sdk/src/files.ts`, `library-files.ts`, `export-animation.ts` | Picker / read or encode / apply or download / cancelled or failed; cancellation is not successful completion. |
| XR lifecycle | `packages/xr/src/shell.ts`, `support.ts` | Unsupported or ready / requesting / running / ended; cleanup releases session-owned resources. |
| Per-hand interaction | `packages/xr/src/interaction.ts`, `input.ts` | Hover / capture by select, squeeze or poke / release or cancel; one capture owner per hand. |
| XR model editing | `packages/xr/src/editor/session.ts`, `tools.ts` | Placement / holding / brush stroke / release; hand and editor stroke lifecycles must settle together. |
| XR windows and menus | `packages/xr/src/windows.ts`, `menu.ts`, `workspace.ts` | Hidden / visible / carried or gathered; persisted placement is distinct from current hand ownership. |

## Persistence and collaboration

| Machine | Owner | States and transition boundary |
| --- | --- | --- |
| Web session | `apps/web/src/session.ts` | Local / snapshot / room, with busy and loading guards; opening a share must not overwrite the local draft. |
| Room socket | `session.ts` | Connecting / open / disconnected with backoff / stopped; callbacks and timers belong to a particular socket lifetime. |
| Sync handshake | `packages/sync/src/client.ts` | Connecting / welcomed / reconnecting / closed; no edit transmission before handshake completes. |
| Optimistic edits | `client.ts` | Queued / sent / acknowledged or rebased; reconnect preserves pending edits and reconciles revisions. |
| Room authority | `packages/sync/src/room.ts`, `apps/worker/` | Join / role and token validation / operation acceptance / close; server revision and authorization remain authoritative. |
| Autosave and library storage | `apps/web/src/autosave.ts`, `library-store.ts` | Dirty / scheduled or writing / saved or failed; local and shared documents have different destinations. |
| Sharing workflows | `apps/web/src/share-dialog.tsx`, `session.ts` | Creating / published / managing or revoked / failed; owner credentials are distinct from viewer/editor tokens. |
| PWA install | `apps/web/src/pwa.ts` | No prompt / prompt available / consumed / installed; native prompt needs a direct tap. |
| PWA update | `pwa.ts` | Available / refresh requested / activated / reload; another tab activating must not force this editor to reload. |
| CLI file session | `packages/cli/src/session.ts` | Loaded / modified relative to saved snapshot / saved; filesystem writes stay within the configured root. |

## Review rule

For a change to any row, identify the owner, accepted events, guards, completion and cancellation,
then check replacement (new file, frame, scene or session), disposal, undo and remote updates.
UI and agent adapters should read capabilities from that owner and invoke its methods. Test
observable transitions and preserved data, rather than mirroring the flags in tests. Touch and
mouse must reach the same core transitions; headset capture remains an input-layer concern.

Further work should be driven by reproduced failures: stale async completions in session/file
workflows, cancellation across multi-pointer and XR input, and replacement during pending edits
are useful audit targets. They are not established bugs in this inventory.
