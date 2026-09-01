'use client';

import * as React from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { CitationRelationKind, Investigation, Source } from '@/core/types';
import { Badge, Button, Section } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { sourceLabel } from '@/components/workspace/shared';

/**
 * The evidence map.
 *
 * A force layout is computed once, synchronously, and then frozen: there is no
 * animation loop, so the graph is stable to read, cheap on battery, identical
 * across renders and screenshots, and safe to render at any size. Panning and
 * zooming are handled directly rather than pulled in as a dependency.
 *
 * Nodes are focusable buttons in DOM order, so the whole graph is reachable by
 * keyboard — a canvas or WebGL renderer would have made that impossible.
 */

/** Layout dimensions used before the container has been measured. */
const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 560;

type NodeKind = 'claim' | 'origin' | 'derived' | 'independent' | 'contradicting';

interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  sublabel: string;
  kind: NodeKind;
  radius: number;
  familyIndex: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  kind: CitationRelationKind;
}

const EDGE_STYLE: Record<CitationRelationKind, { stroke: string; dash?: string; label: string }> = {
  CITES: { stroke: 'var(--color-signal)', dash: '4 3', label: 'Cites' },
  DERIVED_FROM: { stroke: 'var(--color-derived)', label: 'Derived from' },
  REPEATS: { stroke: 'var(--color-derived)', dash: '2 3', label: 'Repeats' },
  SUPPORTS: { stroke: 'var(--color-supports)', label: 'Supports' },
  CONTRADICTS: { stroke: 'var(--color-contradicts)', label: 'Contradicts' },
  AUTHORED_BY: { stroke: 'var(--color-neutral)', dash: '1 4', label: 'Authored by' },
  AFFILIATED_WITH: { stroke: 'var(--color-neutral)', dash: '1 4', label: 'Affiliated with' },
  TESTED_BY: { stroke: 'var(--color-neutral)', label: 'Tested by' },
};

const NODE_FILL: Record<NodeKind, string> = {
  claim: 'var(--color-ink)',
  origin: 'var(--color-brass)',
  independent: 'var(--color-signal)',
  derived: 'var(--color-derived)',
  contradicting: 'var(--color-contradicts)',
};

function nodeKind(source: Source, depth: number, isOrigin: boolean): NodeKind {
  if (source.contradictsClaim && !source.supportsClaim) return 'contradicting';
  if (isOrigin) return 'origin';
  return depth <= 1 ? 'independent' : 'derived';
}

interface Size {
  width: number;
  height: number;
}

function buildGraph(investigation: Investigation): { nodes: GraphNode[]; links: GraphLink[] } {
  const { claim, sources, relationships, lineage } = investigation;
  const originIds = new Set(lineage.families.map((f) => f.originSourceId));
  const familyIndexOf = new Map<string, number>();
  lineage.families.forEach((family, index) => {
    for (const id of family.memberSourceIds) familyIndexOf.set(id, index);
  });

  const nodes: GraphNode[] = [
    {
      id: claim.id,
      label: 'THE CLAIM',
      sublabel: claim.normalized,
      kind: 'claim',
      radius: 13,
      familyIndex: -1,
    },
    ...sources.map<GraphNode>((source) => {
      const depth = lineage.depthBySourceId[source.id] ?? 0;
      const isOrigin = originIds.has(source.id);
      return {
        id: source.id,
        label: sourceLabel(source),
        sublabel: source.title,
        kind: nodeKind(source, depth, isOrigin),
        radius: isOrigin ? 10 : depth <= 1 ? 8 : 6,
        familyIndex: familyIndexOf.get(source.id) ?? -1,
      };
    }),
  ];

  const ids = new Set(nodes.map((n) => n.id));
  const links = relationships
    .filter((rel) => ids.has(rel.fromId) && ids.has(rel.toId))
    .map<GraphLink>((rel) => ({ id: rel.id, source: rel.fromId, target: rel.toId, kind: rel.kind }));

  return { nodes, links };
}

/**
 * Run the layout to completion, then stop.
 *
 * Initial positions are seeded from the node index rather than left to the
 * simulation's defaults, so the same investigation always produces the same
 * picture. A graph that rearranges itself on every reload cannot be discussed.
 */
function layout(nodes: GraphNode[], links: GraphLink[], size: Size): { nodes: GraphNode[]; links: GraphLink[] } {
  const { width, height } = size;
  const seeded = nodes.map((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    const ring = node.kind === 'claim' ? 0 : Math.min(width, height) * 0.28 + (index % 3) * 55;
    return { ...node, x: width / 2 + Math.cos(angle) * ring, y: height / 2 + Math.sin(angle) * ring };
  });
  const simLinks = links.map((link) => ({ ...link }));

  const simulation = forceSimulation(seeded)
    .force(
      'link',
      forceLink<GraphNode, GraphLink>(simLinks)
        .id((d) => d.id)
        .distance((d) => (d.kind === 'SUPPORTS' || d.kind === 'CONTRADICTS' ? 150 : 96))
        .strength(0.55),
    )
    .force('charge', forceManyBody<GraphNode>().strength((d) => (d.kind === 'claim' ? -900 : -320)))
    .force('center', forceCenter(width / 2, height / 2))
    .force('collide', forceCollide<GraphNode>((d) => d.radius + 40).strength(1).iterations(3))
    // Pull each family into its own horizontal band, so families read as clusters.
    .force(
      'family',
      forceX<GraphNode>((d) =>
        d.familyIndex < 0 ? width / 2 : (width / 6) * (1 + ((d.familyIndex * 2) % 5)),
      ).strength(0.06),
    )
    .force('vertical', forceY<GraphNode>(height / 2).strength(0.05))
    .stop();

  simulation.tick(400);
  return { nodes: seeded, links: simLinks };
}

/**
 * The viewBox that exactly frames the laid-out graph.
 *
 * Scaling the box rather than the nodes means labels scale with it, so the
 * diagram stays legible at any container size instead of shrinking into the
 * middle of an empty rectangle.
 */
function fitViewBox(nodes: GraphNode[], size: Size): { x: number; y: number; width: number; height: number } {
  if (nodes.length === 0) return { x: 0, y: 0, width: size.width, height: size.height };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    minX = Math.min(minX, x - node.radius);
    maxX = Math.max(maxX, x + node.radius);
    minY = Math.min(minY, y - node.radius);
    // Labels sit below each node and must stay inside the frame.
    maxY = Math.max(maxY, y + node.radius + 18);
  }
  // Enough padding that edge labels are not clipped by the frame.
  const padX = 70;
  const padY = 24;
  const width = Math.max(240, maxX - minX + padX * 2);
  const height = Math.max(180, maxY - minY + padY * 2);
  return { x: minX - padX, y: minY - padY, width, height };
}

export function EvidenceMap({
  investigation,
  selectedSourceId,
  onSelectSource,
}: {
  investigation: Investigation;
  selectedSourceId: string | null;
  onSelectSource: (id: string) => void;
}): React.ReactElement {
  const frameRef = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState<Size>({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });

  /**
   * Lay the graph out at the shape it will actually be drawn in.
   *
   * A layout computed for a wide desktop frame and then fitted into a tall
   * phone frame letterboxes: the diagram shrinks into a band with dead space
   * above and below. Measuring first means the nodes spread into the space
   * that exists. Rounded to 40px buckets so a resize drag does not re-run the
   * simulation on every frame.
   */
  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const bucket = (n: number): number => Math.max(240, Math.round(n / 40) * 40);
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = { width: bucket(entry.contentRect.width), height: bucket(entry.contentRect.height) };
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const graph = React.useMemo(() => {
    const built = buildGraph(investigation);
    const laid = layout(built.nodes, built.links, size);
    return { ...laid, view: fitViewBox(laid.nodes, size) };
  }, [investigation, size]);

  const [transform, setTransform] = React.useState({ x: 0, y: 0, k: 1 });
  const drag = React.useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);

  const reset = React.useCallback(() => setTransform({ x: 0, y: 0, k: 1 }), []);

  const zoomBy = React.useCallback((factor: number) => {
    setTransform((t) => {
      const k = Math.max(0.45, Math.min(3, t.k * factor));
      // Zoom around the centre of the viewport, not the origin.
      const cx = graph.view.x + graph.view.width / 2;
      const cy = graph.view.y + graph.view.height / 2;
      return { k, x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k };
    });
  }, [graph.view]);

  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Registered non-passively so the page does not scroll while zooming the map.
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  /**
   * Panning is tracked on the window rather than through `setPointerCapture`
   * on the SVG. Capturing on the SVG retargets the subsequent `click` to the
   * SVG itself, which silently swallows every node selection — the graph looks
   * interactive and does nothing.
   */
  const beginPan = React.useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, ox: transform.x, oy: transform.y, moved: false };

    const onMove = (move: PointerEvent): void => {
      const start = drag.current;
      if (!start) return;
      const dx = move.clientX - start.x;
      const dy = move.clientY - start.y;
      // Below this threshold the gesture is a click, not a pan.
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) start.moved = true;
      if (!start.moved) return;
      setTransform((t) => ({ ...t, x: start.ox + dx, y: start.oy + dy }));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      // Cleared after the click has had a chance to run, so a drag that ends
      // over a node does not also select it.
      window.setTimeout(() => {
        drag.current = null;
      }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [transform.x, transform.y]);

  const nodeById = React.useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const claimId = investigation.claim.id;

  if (investigation.sources.length === 0) {
    return (
      <Section id="evidence-map" index="03" title="Evidence Map">
        <p className="px-4 py-6 text-sm text-faint sm:px-5">
          No sources were retrieved, so there is no network to draw.
        </p>
      </Section>
    );
  }

  return (
    <Section
      id="evidence-map"
      index="03"
      title="Evidence Map"
      actions={
        <div className="flex items-center gap-1">
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
            +
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
            −
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={reset}>
            Reset
          </Button>
        </div>
      }
    >
      <div ref={frameRef} className="relative">
        <svg
          ref={svgRef}
          viewBox={`${graph.view.x} ${graph.view.y} ${graph.view.width} ${graph.view.height}`}
          className="block h-[340px] w-full touch-none select-none sm:h-[440px] lg:h-[560px]"
          role="group"
          aria-label={`Evidence network: ${graph.nodes.length} nodes and ${graph.links.length} relationships. Each node is a focusable button.`}
          onPointerDown={beginPan}
        >
          <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
            <g aria-hidden>
              {graph.links.map((link) => {
                const from = typeof link.source === 'object' ? (link.source as GraphNode) : nodeById.get(String(link.source));
                const to = typeof link.target === 'object' ? (link.target as GraphNode) : nodeById.get(String(link.target));
                if (!from || !to) return null;
                const style = EDGE_STYLE[link.kind];
                const dim =
                  selectedSourceId !== null && from.id !== selectedSourceId && to.id !== selectedSourceId;
                return (
                  <line
                    key={link.id}
                    x1={from.x ?? 0}
                    y1={from.y ?? 0}
                    x2={to.x ?? 0}
                    y2={to.y ?? 0}
                    stroke={style.stroke}
                    strokeWidth={link.kind === 'CONTRADICTS' || link.kind === 'SUPPORTS' ? 1.2 : 1}
                    strokeDasharray={style.dash}
                    opacity={dim ? 0.12 : 0.42}
                  />
                );
              })}
            </g>

            {graph.nodes.map((node) => {
              const selected = node.id === selectedSourceId;
              const dim = selectedSourceId !== null && !selected && node.id !== claimId;
              const isClaim = node.id === claimId;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x ?? 0} ${node.y ?? 0})`}
                  opacity={dim ? 0.35 : 1}
                >
                  <g
                    role={isClaim ? 'img' : 'button'}
                    tabIndex={isClaim ? -1 : 0}
                    aria-label={`${node.label}. ${node.sublabel}`}
                    aria-pressed={selected}
                    className={cn('outline-none', isClaim ? 'cursor-default' : 'cursor-pointer')}
                    onClick={() => {
                      if (drag.current?.moved) return;
                      if (!isClaim) onSelectSource(node.id);
                    }}
                    onKeyDown={(event) => {
                      if (!isClaim && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        onSelectSource(node.id);
                      }
                    }}
                  >
                    {/* Invisible hit area: an SVG group has no geometry of its
                        own, and `fill="none"` shapes have no interior to click.
                        This also gives every node a comfortable tap target. */}
                    <circle r={Math.max(node.radius + 12, 18)} fill="transparent" pointerEvents="all" />
                    {selected ? (
                      <circle r={node.radius + 7} fill="none" stroke="var(--color-signal)" strokeWidth={1.5} />
                    ) : null}
                    {isClaim ? (
                      <rect
                        x={-node.radius}
                        y={-node.radius}
                        width={node.radius * 2}
                        height={node.radius * 2}
                        transform="rotate(45)"
                        fill="none"
                        stroke={NODE_FILL.claim}
                        strokeWidth={1.6}
                      />
                    ) : (
                      <circle
                        r={node.radius}
                        fill={NODE_FILL[node.kind]}
                        fillOpacity={node.kind === 'derived' ? 0.35 : 0.9}
                        stroke={NODE_FILL[node.kind]}
                        strokeWidth={1.2}
                      />
                    )}
                    <text
                      y={node.radius + 13}
                      textAnchor="middle"
                      className="pointer-events-none fill-[color:var(--color-dim)] font-mono text-[9px]"
                    >
                      {node.label.length > 26 ? `${node.label.slice(0, 24)}…` : node.label}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
        </svg>

        <p className="pointer-events-none absolute bottom-2 right-3 font-mono text-[10px] text-faint">
          drag to pan · scroll to zoom
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 sm:px-5">
        <LegendDot color={NODE_FILL.origin} label="Origin source" />
        <LegendDot color={NODE_FILL.independent} label="Near-origin" />
        <LegendDot color={NODE_FILL.derived} label="Derivative" />
        <LegendDot color={NODE_FILL.contradicting} label="Contradicts the claim" />
        <span className="ml-auto flex flex-wrap gap-2">
          {(['DERIVED_FROM', 'REPEATS', 'CITES', 'SUPPORTS', 'CONTRADICTS'] as CitationRelationKind[]).map(
            (kind) => (
              <Badge key={kind} tone="neutral">
                {EDGE_STYLE[kind].label}
              </Badge>
            ),
          )}
        </span>
      </div>
    </Section>
  );
}

function LegendDot({ color, label }: { color: string; label: string }): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-dim">
      <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
