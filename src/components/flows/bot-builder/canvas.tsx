"use client";

/**
 * Bot Builder canvas. The trigger is the "Starting
 * point" card; every step is a white card edited in place (no side
 * sheet). Wire steps by dragging from the green dot on a card's right
 * edge (one per quick-reply button / list row / branch) to the next
 * card. A step with nothing after it ends the flow.
 *
 * Node controls (B03): overflow menu (Rename, Duplicate, Make first,
 * Delete with confirmation), a delete button on a selected/hovered
 * connection, issue badge. Keyboard Delete asks for the same confirmation.
 *
 * State lives in the shared flow editor context, so the list view, the
 * validator, undo/redo and Save see exactly the same flow.
 */

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CircleAlert, Copy, Flag, MoreVertical, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots } from "@/lib/flows/edges";
import { autoLayout, shouldAutoLayout } from "@/lib/flows/layout";
import { isBotStudioNode } from "@/lib/flows/node-registry";
import { useStepLabel } from "@/components/automations/automation-builder";
import type { AutomationStepType } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFlowEditor } from "../flow-editor-state";
import { NodeConfigForm } from "../forms/node-config-form";
import { HideRoutingContext } from "../forms/fields";
import { flowVariables } from "../forms/bot-studio-forms";
import { NODE_DRAG_TYPE } from "../node-palette";
import { ADDABLE_NODE_TYPES, NODE_META, type BuilderNode, type NodeType } from "../shared";
import { findItem, itemIdForNode, type CatalogItem } from "./catalog";
import { GoogleSheetsBody, triggerVariables } from "./sheets-body";
import { TriggerBody } from "./trigger-body";
import { InteractiveBody, ListBody, MessageBody } from "./message-bodies";
import { TagsBody, TemplateBody, TimeDelayBody, WaitTillBody } from "./step-bodies";
import { CallApiBody } from "./call-api-body";

export const TRIGGER_ID = "__trigger__";
const CARD_W = 270;
const CARD_H = 240;
const EDGE_COLOR = "#9ca3af";

type StepData = { nodeKey: string };

/** Canvas-wide UI actions the cards need. */
const CanvasUi = createContext<{ showTriggers: () => void; askDelete: (keys: string[]) => void }>({
  showTriggers: () => {},
  askDelete: () => {},
});

// ── Cards ────────────────────────────────────────────────────────────

/**
 * Steps with nothing to configure (or that end the flow) gain nothing
 * from a copy, so only the others offer Duplicate. Every card has Delete.
 */
const NO_DUPLICATE = new Set(["start", "end", "handoff", "opt_out"]);
function canDuplicate(node: { node_type: string; config: Record<string, unknown> }): boolean {
  if (node.node_type === "action" && node.config.step_type === "close_conversation") return false;
  return !NO_DUPLICATE.has(node.node_type);
}

function CardMenu({ items }: { items: { label: string; icon: typeof Copy; onClick: () => void; danger?: boolean }[] }) {
  const t = useTranslations("BotStudio.builder");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t("stepMenu")} className="text-muted-foreground hover:text-foreground hover:bg-muted -mr-1 rounded p-0.5">
        <MoreVertical className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map((it, i) => (
          <span key={it.label}>
            {it.danger && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={it.onClick} className={cn(it.danger && "text-red-500")}>
              <it.icon className="h-4 w-4" />
              {it.label}
            </DropdownMenuItem>
          </span>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TriggerNode = memo(function TriggerNode({ selected }: NodeProps) {
  const t = useTranslations("BotStudio.builder");
  const { state, setState, duplicateFlow, deleteFlow } = useFlowEditor();
  const ui = useContext(CanvasUi);
  return (
    <div className="relative" style={{ width: 240 }}>
      <div className="absolute -top-[26px] left-0 rounded-t-md bg-neutral-900 px-2.5 py-1 text-[11px] font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900">
        {t("startingPoint")}
      </div>
      <div className={cn("bg-card rounded-lg rounded-tl-none border shadow-[0_1px_4px_rgba(0,0,0,0.08)]", selected ? "border-emerald-600" : "border-border")}>
        <div className="bb-drag flex cursor-grab items-center justify-between gap-1 px-3 pt-2.5 active:cursor-grabbing">
          <span className="text-muted-foreground truncate text-[12px] font-semibold">{t(`items.${state.trigger_type}`)}</span>
          <CardMenu
            items={[
              { label: t("changeTrigger"), icon: RefreshCw, onClick: ui.showTriggers },
              // A flow has one starting point, so Duplicate / Delete here
              // act on the whole flow.
              { label: t("duplicateFlow"), icon: Copy, onClick: () => void duplicateFlow() },
              // Removing the trigger leaves "Started manually" (inbox / another flow).
              {
                label: t("removeTrigger"),
                icon: X,
                danger: true,
                onClick: () => setState((s) => ({ ...s, trigger_type: "manual", trigger_config: {} })),
              },
              { label: t("deleteFlow"), icon: Trash2, danger: true, onClick: () => void deleteFlow() },
            ]}
          />
        </div>
        <div className="nodrag nowheel nopan cursor-auto px-3 pt-1.5 pb-3">
          <TriggerBody />
        </div>
      </div>
      <Handle type="source" id="out" position={Position.Right} className="!h-2.5 !w-2.5 !border-0 !bg-emerald-600" />
    </div>
  );
});

const StepNode = memo(function StepNode({ data, selected }: NodeProps) {
  const t = useTranslations("BotStudio.builder");
  const tb = useTranslations("BotStudio.flows");
  const tf = useTranslations("Flows.builder");
  const stepLabel = useStepLabel();
  const ui = useContext(CanvasUi);
  const { state, issues, updateNodeConfig, duplicateNode, setState, flashKey } = useFlowEditor();
  const [renaming, setRenaming] = useState(false);
  const key = (data as StepData).nodeKey;
  const node = state.nodes.find((n) => n.node_key === key);
  const vars = useMemo(
    () => [...triggerVariables(state.trigger_type, state.trigger_config ?? {}), ...flowVariables(state.nodes)],
    [state.nodes, state.trigger_type, state.trigger_config],
  );
  if (!node) return null;

  const itemId = itemIdForNode(node);
  const known = findItem(itemId);
  const custom = typeof node.config._title === "string" ? (node.config._title as string) : "";
  const title =
    custom ||
    (known
      ? t(`items.${itemId}`)
      : node.node_type === "action"
        ? stepLabel(String(node.config.step_type) as AutomationStepType)
        : Object.prototype.hasOwnProperty.call(NODE_META, node.node_type)
          ? tf(`nodes.${node.node_type}.label`)
          : tb("unknownNode", { type: node.node_type }));
  const mine = issues.filter((i) => i.node_key === key);
  const hasError = mine.some((i) => i.severity === "error");
  const slots = outgoingSlots(node);
  const isEntry = state.entry_node_id === key;

  const menu = [
    { label: t("rename"), icon: Pencil, onClick: () => setRenaming(true) },
    ...(canDuplicate(node) ? [{ label: t("duplicate"), icon: Copy, onClick: () => duplicateNode(key) }] : []),
    ...(!isEntry ? [{ label: t("setFirst"), icon: Flag, onClick: () => setState((s) => ({ ...s, entry_node_id: key })) }] : []),
    { label: t("delete"), icon: Trash2, onClick: () => ui.askDelete([key]), danger: true },
  ];
  const update = (patch: Record<string, unknown>) => updateNodeConfig(key, patch);

  let body: React.ReactNode;
  let ownHandles = false;
  switch (node.node_type) {
    case "send_buttons":
      body = <InteractiveBody node={node} vars={vars} onUpdate={update} />;
      ownHandles = true;
      break;
    case "send_list":
      body = <ListBody node={node} vars={vars} onUpdate={update} />;
      ownHandles = true;
      break;
    case "send_message":
      body = <MessageBody node={node} vars={vars} onUpdate={update} />;
      break;
    case "time_delay":
      body = <TimeDelayBody node={node} onUpdate={update} />;
      break;
    case "wait_until":
      body = <WaitTillBody node={node} vars={vars} onUpdate={update} />;
      break;
    case "set_tag":
      body = <TagsBody node={node} onUpdate={update} />;
      break;
    case "send_template":
      body = <TemplateBody node={node} vars={vars} onUpdate={update} />;
      break;
    case "call_api":
      body = <CallApiBody node={node} onUpdate={update} />;
      break;
    case "google_sheets":
      body = <GoogleSheetsBody node={node} vars={vars} onUpdate={update} />;
      break;
    default:
      body = (
        <HideRoutingContext.Provider value={true}>
          <div className="bb-form flex flex-col gap-2.5 text-[13px] [&_.grid]:!grid-cols-1">
            <NodeConfigForm node={node} allNodes={state.nodes} showAdvanced={false} onUpdateConfig={update} />
          </div>
        </HideRoutingContext.Provider>
      );
  }

  return (
    <div
      className={cn(
        "bg-card relative rounded-lg border shadow-[0_1px_4px_rgba(0,0,0,0.08)] transition-shadow",
        selected ? "border-emerald-600 shadow-[0_6px_20px_-8px_rgba(0,0,0,0.25)]" : "border-border",
        flashKey === key && "ring-2 ring-amber-400",
      )}
      style={{ width: CARD_W }}
    >
      <Handle type="target" position={Position.Left} style={{ top: 22 }} className="!h-2.5 !w-2.5 !border-0 !bg-neutral-400" />
      <div className="bb-drag flex cursor-grab items-center gap-1.5 px-3 pt-2.5 active:cursor-grabbing">
        {renaming ? (
          <input
            autoFocus
            defaultValue={custom || title}
            maxLength={60}
            aria-label={t("rename")}
            className="nodrag min-w-0 flex-1 rounded border border-emerald-600 bg-transparent px-1 text-[12px] font-semibold outline-none"
            onBlur={(e) => {
              const v = e.target.value.trim();
              update({ _title: v && v !== (known ? t(`items.${itemId}`) : "") ? v : undefined });
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px] font-semibold" onDoubleClick={() => setRenaming(true)}>
            {title}
          </span>
        )}
        {isEntry && <span className="rounded bg-emerald-600/10 px-1.5 text-[9.5px] font-semibold text-emerald-700 dark:text-emerald-400">{t("first")}</span>}
        {mine.length > 0 && (
          <span title={mine.map((i) => i.message).join("\n")}>
            <CircleAlert className={cn("h-3.5 w-3.5", hasError ? "text-red-500" : "text-amber-500")} />
          </span>
        )}
        <CardMenu items={menu} />
      </div>
      <div className="nodrag nowheel nopan cursor-auto px-3 pt-1.5 pb-3">{body}</div>

      {!ownHandles && slots.length === 1 && (
        <Handle type="source" id={slots[0].id} position={Position.Right} className="!h-2.5 !w-2.5 !border-0 !bg-emerald-600" />
      )}
      {!ownHandles && slots.length > 1 && (
        <div className="border-border flex flex-col gap-1 border-t px-3 py-2">
          {slots.map((s) => (
            <div key={s.id} className="text-muted-foreground relative flex items-center justify-end text-[11.5px]">
              <span className="truncate pr-1">{isBotStudioNode(node.node_type) ? tb(`slots.${s.id}`) : s.label}</span>
              <Handle
                type="source"
                id={s.id}
                position={Position.Right}
                className="!relative !top-auto !right-auto !h-2.5 !w-2.5 !translate-x-[14px] !transform-none !border-0 !bg-emerald-600"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** Curved connection with a delete button when hovered or selected (B03.06). */
function RemovableEdge(props: EdgeProps) {
  const t = useTranslations("BotStudio.builder");
  const rf = useReactFlow();
  const [hover, setHover] = useState(false);
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} />
      {/* Wide invisible path so the edge is easy to hover. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={18} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />
      {(hover || props.selected) && props.deletable !== false && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label={t("deleteConnection")}
            title={t("deleteConnection")}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={() => void rf.deleteElements({ edges: [{ id: props.id }] })}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="nodrag nopan bg-card text-muted-foreground absolute rounded-full border p-0.5 shadow-sm hover:text-red-500"
          >
            <X className="h-3 w-3" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { trigger: TriggerNode, step: StepNode };
const EDGE_TYPES = { removable: RemovableEdge };

// ── Canvas ───────────────────────────────────────────────────────────

export function BuilderCanvas({
  onAddItem,
  onShowTriggers,
}: {
  onAddItem: (item: Extract<CatalogItem, { kind: "action" }>, at?: { x: number; y: number }) => void;
  onShowTriggers: () => void;
}) {
  const t = useTranslations("BotStudio.builder");
  const { state, setState, updateNodeConfig, updateNodePosition, updateNodePositions, removeNode, flashKey } = useFlowEditor();
  const rf = useReactFlow();
  const builderNodes = state.nodes;
  const entry = state.entry_node_id;

  // Delete confirmation (menu and keyboard): Cancel / Delete.
  const [pendingDelete, setPendingDelete] = useState<{ keys: string[]; resolve?: (ok: boolean) => void } | null>(null);
  const askDelete = useCallback((keys: string[]) => setPendingDelete({ keys }), []);
  const finishDelete = (ok: boolean) => {
    if (!pendingDelete) return;
    if (pendingDelete.resolve) pendingDelete.resolve(ok);
    else if (ok) for (const k of pendingDelete.keys) removeNode(k);
    setPendingDelete(null);
  };
  const ui = useMemo(() => ({ showTriggers: onShowTriggers, askDelete }), [onShowTriggers, askDelete]);

  const layout = useMemo(() => {
    if (!shouldAutoLayout(builderNodes)) return null;
    return autoLayout(
      builderNodes.map((n) => ({ id: n.node_key, width: CARD_W, height: CARD_H })),
      deriveCanvasEdges(builderNodes).map((e) => ({ source: e.source, target: e.target })),
      { direction: "LR" },
    );
  }, [builderNodes]);
  const persisted = useRef(false);
  useEffect(() => {
    if (!layout || persisted.current) return;
    persisted.current = true;
    updateNodePositions(Object.fromEntries([...layout].map(([k, p]) => [k, p])));
  }, [layout, updateNodePositions]);

  // The trigger card sits left of the first step; dragging it is local
  // (it isn't a saved node).
  const [triggerOffset, setTriggerOffset] = useState<{ x: number; y: number } | null>(null);
  const anchor = useMemo(() => {
    const pos = (n: BuilderNode) => layout?.get(n.node_key) ?? { x: n.position_x ?? 0, y: n.position_y ?? 0 };
    const first = builderNodes.find((n) => n.node_key === entry) ?? builderNodes[0];
    if (!first) return { x: 0, y: 0 };
    const p = pos(first);
    return { x: p.x - 340, y: p.y };
  }, [builderNodes, entry, layout]);

  const derived = useMemo<Node[]>(() => {
    const out: Node[] = [
      { id: TRIGGER_ID, type: "trigger", position: triggerOffset ?? anchor, data: {}, deletable: false, dragHandle: ".bb-drag" },
    ];
    for (const n of builderNodes) {
      const p = layout?.get(n.node_key) ?? { x: n.position_x ?? 0, y: n.position_y ?? 0 };
      out.push({ id: n.node_key, type: "step", position: p, data: { nodeKey: n.node_key } satisfies StepData, dragHandle: ".bb-drag" });
    }
    return out;
  }, [builderNodes, layout, anchor, triggerOffset]);

  // React Flow keeps the live (mid-drag) copy; re-sync whenever the
  // editor state changes (adjust-state-during-render pattern).
  const [nodes, setNodes] = useState<Node[]>(derived);
  const [synced, setSynced] = useState(derived);
  if (synced !== derived) {
    setSynced(derived);
    setNodes(derived);
  }

  const edges = useMemo<Edge[]>(() => {
    const style = { stroke: EDGE_COLOR, strokeWidth: 1.4 };
    const marker = { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 16, height: 16 };
    const list: Edge[] = deriveCanvasEdges(builderNodes).map((e) => ({
      id: e.id,
      type: "removable",
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      style,
      markerEnd: marker,
    }));
    if (entry && builderNodes.some((n) => n.node_key === entry)) {
      list.push({ id: `${TRIGGER_ID}->${entry}`, type: "removable", source: TRIGGER_ID, sourceHandle: "out", target: entry, style, markerEnd: marker });
    }
    return list;
  }, [builderNodes, entry]);

  const onNodesChange = useCallback((c: NodeChange[]) => setNodes((ns) => applyNodeChanges(c, ns)), []);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.target === TRIGGER_ID || c.source === c.target) return;
      if (c.source === TRIGGER_ID) {
        const target = c.target;
        setState((s) => ({ ...s, entry_node_id: target }));
        return;
      }
      const src = builderNodes.find((n) => n.node_key === c.source);
      if (!src || !c.sourceHandle) return;
      const patch = applyEdgeConnection(src, c.sourceHandle, c.target);
      if (patch) updateNodeConfig(c.source, patch);
    },
    [builderNodes, setState, updateNodeConfig],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) {
        if (e.source === TRIGGER_ID) {
          setState((s) => ({ ...s, entry_node_id: null }));
          continue;
        }
        const src = builderNodes.find((n) => n.node_key === e.source);
        if (!src || !e.sourceHandle) continue;
        const patch = applyEdgeConnection(src, e.sourceHandle, "");
        if (patch) updateNodeConfig(e.source, patch);
      }
    },
    [builderNodes, setState, updateNodeConfig],
  );

  // Keyboard Delete on steps asks first (edges alone delete directly).
  const onBeforeDelete = useCallback(
    async ({ nodes: ns }: { nodes: Node[]; edges: Edge[] }) => {
      const keys = ns.map((n) => n.id).filter((id) => id !== TRIGGER_ID);
      if (!keys.length) return true;
      return new Promise<boolean>((resolve) => setPendingDelete({ keys, resolve }));
    },
    [],
  );
  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      for (const n of deleted) if (n.id !== TRIGGER_ID) removeNode(n.id);
    },
    [removeNode],
  );

  const onDragStop = useCallback(
    (_: unknown, n: Node) => {
      if (n.id === TRIGGER_ID) setTriggerOffset(n.position);
      else updateNodePosition(n.id, n.position.x, n.position.y);
    },
    [updateNodePosition],
  );

  // Drop from the side panel (catalogue id) or the old palette (node type).
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(NODE_DRAG_TYPE);
      if (!id) return;
      e.preventDefault();
      const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const item = findItem(id);
      if (item?.kind === "action") onAddItem(item, { x: at.x - 30, y: at.y - 20 });
      else if (ADDABLE_NODE_TYPES.includes(id as NodeType)) {
        onAddItem({ id, kind: "action", node: id as NodeType, icon: Copy, color: "" }, { x: at.x - 30, y: at.y - 20 });
      }
    },
    [onAddItem, rf],
  );

  // Validator "look here": pan to the step.
  useEffect(() => {
    if (!flashKey) return;
    const n = builderNodes.find((x) => x.node_key === flashKey);
    if (n) rf.setCenter((n.position_x ?? 0) + CARD_W / 2, (n.position_y ?? 0) + 120, { zoom: rf.getZoom(), duration: 400 });
  }, [flashKey, builderNodes, rf]);

  return (
    <CanvasUi.Provider value={ui}>
      <div className="bb-canvas h-full w-full bg-[var(--bb-canvas,var(--background))]" onDragOver={onDragOver} onDrop={onDrop}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onBeforeDelete={onBeforeDelete}
          onNodesDelete={onNodesDelete}
          onNodeDragStop={onDragStop}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--border)" />
          <Controls
            position="bottom-left"
            showInteractive
            className="!border-border !bg-card [&_button]:!border-border [&_button]:!bg-card [&_button:hover]:!bg-muted [&_button_svg]:!fill-foreground !overflow-hidden !rounded-md !border !shadow-sm"
          />
        </ReactFlow>
        {builderNodes.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center">
            <p className="bg-card text-muted-foreground rounded-md border border-dashed px-4 py-2 text-sm">{t("emptyHint")}</p>
          </div>
        )}
      </div>

      <Dialog open={pendingDelete !== null} onOpenChange={(o) => !o && finishDelete(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteItemTitle")}</DialogTitle>
            <DialogDescription>{t("deleteItemBody", { count: pendingDelete?.keys.length ?? 1 })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => finishDelete(false)}>{t("cancel")}</Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" onClick={() => finishDelete(true)}>{t("delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CanvasUi.Provider>
  );
}
