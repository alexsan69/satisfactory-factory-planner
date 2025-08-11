import React, { useEffect, useMemo, useRef, useState } from "react";
import RECIPES_DATA from "./data/recipes.json";

/* ===================== Types & constantes ===================== */
export type BuildingId =
  | "smelter"
  | "constructor"
  | "assembler"
  | "manufacturer"
  | "splitter"
  | "merger";

export interface Ingredient { name: string; rate: number } // /min
export interface Recipe {
  id: string;
  product: { name: string; rate: number }; // /min
  inputs: Ingredient[];
  building: BuildingId;
  alt?: boolean;
}

type ToolType = "select" | "place" | "belt";

interface PlacedEntity {
  id: string;
  type: BuildingId | "belt";
  x: number; // m
  y: number; // m
  rotation: 0 | 90 | 180 | 270; // 0 = entrée gauche / sortie droite
  meta?: any; // { w, h, node? }
}

type Node = {
  name: string;
  recipeId: string;
  building: BuildingId;
  outputRate: number; // /min
  machines: number;
  inputs: { name: string; rate: number; from?: Node }[];
};

type BeltSegment = { x: number; y: number; w: number; h: number }; // m
type Belt = { id: string; mk: number; rate: number; segments: BeltSegment[] };

const FOUNDATION_M = 8;
const BELT_SPEEDS = [60, 120, 270, 480, 780]; // Mk1..Mk5
const BUILDINGS: Record<
  BuildingId,
  { id: BuildingId; name: string; w: number; h: number; inputs: number; outputs: number }
> = {
  smelter:      { id: "smelter",      name: "Smelter",      w: 6,  h: 9,  inputs: 1, outputs: 1 },
  constructor:  { id: "constructor",  name: "Constructor",  w: 8,  h: 10, inputs: 1, outputs: 1 },
  assembler:    { id: "assembler",    name: "Assembler",    w: 10, h: 15, inputs: 2, outputs: 1 },
  manufacturer: { id: "manufacturer", name: "Manufacturer", w: 18, h: 20, inputs: 4, outputs: 1 },
  splitter:     { id: "splitter",     name: "Splitter",     w: 4,  h: 4,  inputs: 1, outputs: 3 },
  merger:       { id: "merger",       name: "Merger",       w: 4,  h: 4,  inputs: 3, outputs: 1 },
};

const DEFAULT_SCALE_PX_PER_M = 15; // un peu plus grand par défaut
const PATH_GRID_M = 1;             // résolution du pathfinding (1 m)
const BELT_THICKNESS_M = 0.3;      // épaisseur visuelle de la bande
const CLEARANCE_M = 0.6;           // marge de sécurité autour des obstacles
const START_END_FREE_RADIUS = 1;   // tolérance autour des ports
const ENTITY_PADDING_M = 0.4;      // espace min entre entités

/* ======================= Composant principal ======================= */
export default function FactoryPlanner() {
  // UI
  const [scale, setScale] = useState(DEFAULT_SCALE_PX_PER_M);
  const [gridStep, setGridStep] = useState(1);
  const [tool, setTool] = useState<ToolType>("select");
  const [palette, setPalette] = useState<BuildingId>("constructor");
  const [entities, setEntities] = useState<PlacedEntity[]>([]);
  const [belts, setBelts] = useState<Belt[]>([]);

  // Data
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [productList, setProductList] = useState<string[]>([]);
  const [targetItem, setTargetItem] = useState<string>("");
  const [targetRate, setTargetRate] = useState<number>(15);
  const [preferAlt, setPreferAlt] = useState<boolean>(false);

  const boardRef = useRef<HTMLDivElement>(null);

  const toPx = (m: number) => Math.round(m * scale);
  const snapToGrid = (m: number) => Math.round(m / gridStep) * gridStep;

  useEffect(() => {
    const data = RECIPES_DATA as Recipe[];
    setRecipes(data);
    const uniques = Array.from(new Set(data.map(r => r.product.name)));
    setProductList(uniques.sort());
  }, []);

  const hasAlt = useMemo(() => {
    if (!targetItem) return false;
    const candidates = recipes.filter(r => r.product.name === targetItem);
    return candidates.some(r => r.alt);
  }, [recipes, targetItem]);

  /* ---------------------------- Interactions ---------------------------- */
  function addEntity(e: Omit<PlacedEntity, "id">) {
    setEntities(prev => [...prev, { ...e, id: Math.random().toString(36).slice(2, 9) }]);
  }
  function removeEntity(id: string) { setEntities(prev => prev.filter(p => p.id !== id)); }

  function handleBoardClick(ev: React.MouseEvent) {
    if (!boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) / scale;
    const my = (ev.clientY - rect.top) / scale;
    const x = snapToGrid(mx);
    const y = snapToGrid(my);
    if (tool === "place") {
      const spec = BUILDINGS[palette];
      const pos = findFreePositionNear(x, y, spec.w, spec.h, entities);
      addEntity({ type: palette, x: pos.x, y: pos.y, rotation: 0, meta: { w: spec.w, h: spec.h } });
    }
  }

  /* ------------------------- Planificateur (graph) ------------------------- */
  function findRecipeByProduct(productName: string, preferAltLocal: boolean): Recipe | undefined {
    const candidates = recipes.filter(r => r.product.name === productName);
    if (candidates.length === 0) return undefined;
    const std = candidates.find(r => !r.alt);
    const alt = candidates.find(r => !!r.alt);
    return preferAltLocal ? (alt || std || candidates[0]) : (std || alt || candidates[0]);
  }

  function buildChain(productName: string, rate: number, preferAltLocal: boolean): Node | null {
    const r = findRecipeByProduct(productName, preferAltLocal);
    if (!r) return null;
    const machines = rate / r.product.rate;

    const node: Node = {
      name: r.product.name,
      recipeId: r.id,
      building: r.building,
      outputRate: rate,
      machines,
      inputs: r.inputs.map(inp => ({ name: inp.name, rate: (rate * inp.rate) / r.product.rate })),
    };

    node.inputs = node.inputs.map(inp => {
      const sub = findRecipeByProduct(inp.name, preferAltLocal);
      if (sub) {
        const child = buildChain(inp.name, inp.rate, preferAltLocal);
        return { ...inp, from: child || undefined };
      }
      return inp;
    });

    return node;
  }

  function minBeltMkFor(rate: number) {
    const idx = BELT_SPEEDS.findIndex(cap => rate <= cap);
    return idx === -1 ? 5 : idx + 1;
  }

  /* ---------------------- Collision & placement utils --------------------- */
  type Rect = { x: number; y: number; w: number; h: number };
  function rectOfEntity(e: PlacedEntity): Rect {
    return { x: e.x, y: e.y, w: e.meta?.w ?? 2, h: e.meta?.h ?? 2 };
  }
  function expandRect(r: Rect, m: number): Rect {
    return { x: r.x - m, y: r.y - m, w: r.w + 2*m, h: r.h + 2*m };
  }
  function intersects(a: Rect, b: Rect) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }
  function collidesAny(r: Rect, obs: PlacedEntity[]) {
    const rr = expandRect(r, ENTITY_PADDING_M);
    return obs.some(o => intersects(rr, rectOfEntity(o)));
  }
  // Cherche une position libre proche (spirale simple)
  function findFreePositionNear(x:number, y:number, w:number, h:number, obs: PlacedEntity[]) {
    const maxR = 40;
    const step = 1;
    for (let r=0; r<=maxR; r+=step) {
      const candidates = [
        {x:x, y:y+r}, {x:x, y:y-r},
        {x:x+r, y:y}, {x:x-r, y:y},
        {x:x+r, y:y+r}, {x:x-r, y:y+r}, {x:x+r, y:y-r}, {x:x-r, y:y-r},
      ];
      for (const c of candidates) {
        const rc = { x: snapToGrid(c.x), y: snapToGrid(c.y), w, h };
        if (!collidesAny(rc, obs)) return { x: rc.x, y: rc.y };
      }
    }
    return { x, y };
  }

  /* ------------------------ Auto-layout des machines ----------------------- */
  function autoLayout(root: Node, originX = 0, originY = 0) {
    const layers: Node[][] = [];
    (function traverse(n: Node, depth: number) {
      if (!layers[depth]) layers[depth] = [];
      if (!layers[depth].includes(n)) layers[depth].push(n);
      n.inputs.forEach(i => { if (i.from) traverse(i.from, depth + 1); });
    })(root, 0);

    // On pose de gauche (matières) à droite (produit)
    let yBase = originY;
    const placements: PlacedEntity[] = [];
    const obstacles: PlacedEntity[] = [];

    layers.slice().reverse().forEach(nodes => {
      let x = originX;
      nodes.forEach(node => {
        const spec = BUILDINGS[node.building];
        const count = Math.ceil(node.machines * 100) / 100;
        const spacing = 2; // m
        const perRow = Math.max(1, Math.floor((FOUNDATION_M * 6) / (spec.w + spacing)));
        let placed = 0;
        while (placed < Math.ceil(count)) {
          const col = placed % perRow;
          const row = Math.floor(placed / perRow);
          const cx = x + col * (spec.w + spacing);
          const cy = yBase + row * (spec.h + spacing);

          const pos = findFreePositionNear(snapToGrid(cx), snapToGrid(cy), spec.w, spec.h, obstacles);

          const ent: PlacedEntity = {
            id: Math.random().toString(36).slice(2, 9),
            type: node.building,
            x: pos.x,
            y: pos.y,
            rotation: 0, // flux gauche→droite
            meta: { w: spec.w, h: spec.h, node },
          };
          placements.push(ent);
          obstacles.push(ent);
          placed++;
        }
        x += (perRow * (spec.w + spacing)) + 8; // +1 dalle
      });
      yBase += 12;
    });
    return placements;
  }

  /* ================= Routage A* qui évite les machines (v2.7+) ================ */
  function pointInRect(px: number, py: number, r: Rect) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  // A* sur grille 1 m, 4 directions, avec obstacles rectangulaires élargis
  function routeAvoidingMachines(
    start: {x:number;y:number},
    end: {x:number;y:number},
    ens: PlacedEntity[]
  ): BeltSegment[] {
    const obstacles = ens.map(rectOfEntity).map(r => expandRect(r, CLEARANCE_M));

    const xs = [start.x, end.x, ...obstacles.map(r=>r.x), ...obstacles.map(r=>r.x+r.w)];
    const ys = [start.y, end.y, ...obstacles.map(r=>r.y), ...obstacles.map(r=>r.y+r.h)];
    let minX = Math.floor(Math.min(...xs) - 12);
    let maxX = Math.ceil (Math.max(...xs) + 12);
    let minY = Math.floor(Math.min(...ys) - 12);
    let maxY = Math.ceil (Math.max(...ys) + 12);

    const cols = Math.max(1, Math.round((maxX - minX) / PATH_GRID_M));
    const rows = Math.max(1, Math.round((maxY - minY) / PATH_GRID_M));

    function toGridX(x:number){ return Math.round((x - minX) / PATH_GRID_M); }
    function toGridY(y:number){ return Math.round((y - minY) / PATH_GRID_M); }
    function toWorldX(gx:number){ return minX + gx * PATH_GRID_M; }
    function toWorldY(gy:number){ return minY + gy * PATH_GRID_M; }

    const sGX = toGridX(start.x), sGY = toGridY(start.y);
    const eGX = toGridX(end.x),   eGY = toGridY(end.y);

    function collides(cx:number, cy:number) {
      // Laisse respirer près des ports
      if (Math.hypot(cx - start.x, cy - start.y) <= START_END_FREE_RADIUS) return false;
      if (Math.hypot(cx - end.x,   cy - end.y)   <= START_END_FREE_RADIUS) return false;
      for (const r of obstacles) {
        if (pointInRect(cx, cy, r)) return true;
      }
      return false;
    }

    const open: Array<[number, number, number]> = [];
    const gScore = new Map<string, number>();
    const fScore = new Map<string, number>();
    const came   = new Map<string, string>();
    function key(gx:number,gy:number){ return `${gx},${gy}`; }

    const sKey = key(sGX,sGY);
    gScore.set(sKey, 0);
    fScore.set(sKey, Math.abs(sGX-eGX)+Math.abs(sGY-eGY));
    open.push([fScore.get(sKey)!, sGX, sGY]);

    const inBounds = (gx:number, gy:number) => gx>=0 && gx<cols && gy>=0 && gy<rows;

    let steps = 0, foundKey: string | null = null;
    while (open.length) {
      open.sort((a,b)=>a[0]-b[0]);
      const [, gx, gy] = open.shift()!;
      const k = key(gx,gy);
      if (gx === eGX && gy === eGY) { foundKey = k; break; }
      const neigh = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx,dy] of neigh) {
        const ngx = gx+dx, ngy = gy+dy;
        if (!inBounds(ngx,ngy)) continue;
        const cx = toWorldX(ngx), cy = toWorldY(ngy);
        if (collides(cx,cy)) continue;
        const nk = key(ngx,ngy);
        const tentative = (gScore.get(k) ?? Infinity) + 1;
        if (tentative < (gScore.get(nk) ?? Infinity)) {
          came.set(nk, k);
          gScore.set(nk, tentative);
          const h = Math.abs(ngx - eGX) + Math.abs(ngy - eGY);
          const f = tentative + h;
          fScore.set(nk, f);
          if (!open.find(t => t[1]===ngx && t[2]===ngy)) open.push([f, ngx, ngy]);
        }
      }
      steps++;
      if (steps > 150000) break;
    }

    if (!foundKey) return routeManhattan(start, end);

    // Reconstruit le chemin
    const cells: Array<{x:number;y:number}> = [];
    let cur = key(eGX,eGY);
    while (cur !== sKey) {
      const [gx,gy] = cur.split(",").map(Number);
      cells.push({ x: toWorldX(gx), y: toWorldY(gy) });
      cur = came.get(cur)!;
      if (!cur) break;
    }
    cells.push({ x: start.x, y: start.y });
    cells.reverse();

    // Compresse en segments
    const segs: BeltSegment[] = [];
    let i = 0;
    while (i < cells.length - 1) {
      const a = cells[i];
      let j = i + 1;
      const dirX = Math.sign(cells[j].x - a.x);
      const dirY = Math.sign(cells[j].y - a.y);
      while (j + 1 < cells.length) {
        const nx = Math.sign(cells[j+1].x - cells[j].x);
        const ny = Math.sign(cells[j+1].y - cells[j].y);
        if (nx !== dirX || ny !== dirY) break;
        j++;
      }
      const b = cells[j];
      if (dirY === 0) {
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        segs.push({ x: x1, y: a.y - BELT_THICKNESS_M/2, w: x2 - x1, h: BELT_THICKNESS_M });
      } else {
        const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        segs.push({ x: a.x - BELT_THICKNESS_M/2, y: y1, w: BELT_THICKNESS_M, h: y2 - y1 });
      }
      i = j;
    }
    return segs;
  }

  // L fallback “L”
  function routeManhattan(a: {x:number;y:number}, b: {x:number;y:number}): BeltSegment[] {
    const t = BELT_THICKNESS_M;
    const midX = Math.round(((a.x + b.x) / 2) / PATH_GRID_M) * PATH_GRID_M;
    const segs: BeltSegment[] = [];
    const x1 = Math.min(a.x, midX), x2 = Math.max(a.x, midX);
    segs.push({ x: x1, y: a.y - t/2, w: x2 - x1, h: t });
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    segs.push({ x: midX - t/2, y: y1, w: t, h: y2 - y1 });
    const x3 = Math.min(midX, b.x), x4 = Math.max(midX, b.x);
    segs.push({ x: x3, y: b.y - t/2, w: x4 - x3, h: t });
    return segs;
  }

  /* ---------------------------- Ports I/O ---------------------------- */
  // Combien d’entrées/sorties pour une entité donnée
  function inputsCount(e: PlacedEntity) {
    if (e.type === "merger") return 3;
    if (e.meta?.node?.inputs?.length) return e.meta.node.inputs.length;
    return BUILDINGS[e.type as BuildingId]?.inputs ?? 1;
  }
  function outputsCount(e: PlacedEntity) {
    if (e.type === "splitter") return 3;
    return BUILDINGS[e.type as BuildingId]?.outputs ?? 1;
  }

  // Coord. port entrée/sortie (rotation 0 = entrées à gauche, sorties à droite)
  function inputPortOf(e: PlacedEntity, idx = 0) {
    const w = e.meta?.w ?? 2, h = e.meta?.h ?? 2;
    const n = Math.max(1, inputsCount(e));
    const y = e.y + ((idx + 1) * (h / (n + 1)));
    const x = e.x; // côté gauche
    return { x, y };
  }
  function outputPortOf(e: PlacedEntity, idx = 0) {
    const w = e.meta?.w ?? 2, h = e.meta?.h ?? 2;
    const n = Math.max(1, outputsCount(e));
    const y = e.y + ((idx + 1) * (h / (n + 1)));
    const x = e.x + w; // côté droit
    return { x, y };
  }

  /* ------------------- Splitters/Mergers & planification ------------------- */
  function collectEdges(root: Node) {
    const edges: { from: Node; to: Node; inputIndex: number; rate: number }[] = [];
    (function dfs(n: Node) {
      n.inputs.forEach((inp, i) => {
        if (inp.from) {
          edges.push({ from: inp.from, to: n, inputIndex: i, rate: inp.rate });
          dfs(inp.from);
        }
      });
    })(root);
    return edges;
  }

  function entitiesForNode(ens: PlacedEntity[], node?: Node) {
    if (!node) return [] as PlacedEntity[];
    return ens.filter(e => e.meta?.node?.recipeId === node.recipeId);
  }

  function placeSplitterNear(prod: PlacedEntity, obs: PlacedEntity[]): PlacedEntity {
    const spec = BUILDINGS["splitter"];
    const w = prod.meta?.w ?? 2, h = prod.meta?.h ?? 2;
    const intended = { x: prod.x + w + 1, y: prod.y + h / 2 - spec.h / 2 };
    const pos = findFreePositionNear(intended.x, intended.y, spec.w, spec.h, obs);
    return { id: Math.random().toString(36).slice(2,9), type: "splitter", x: pos.x, y: pos.y, rotation: 0, meta: { w: spec.w, h: spec.h } };
  }
  function placeMergerNear(cons: PlacedEntity, obs: PlacedEntity[]): PlacedEntity {
    const spec = BUILDINGS["merger"];
    const w = cons.meta?.w ?? 2, h = cons.meta?.h ?? 2;
    const intended = { x: cons.x - spec.w - 1, y: cons.y + h / 2 - spec.h / 2 };
    const pos = findFreePositionNear(intended.x, intended.y, spec.w, spec.h, obs);
    return { id: Math.random().toString(36).slice(2,9), type: "merger", x: pos.x, y: pos.y, rotation: 0, meta: { w: spec.w, h: spec.h } };
  }

  function planBeltsWithJunctions(allEntities: PlacedEntity[], root: Node) {
    const edges = collectEdges(root);
    const belts: Belt[] = [];
    const extras: PlacedEntity[] = [];
    const obstacles: PlacedEntity[] = [...allEntities];

    const splitterByProdId = new Map<string, PlacedEntity>();
    const mergerByConsId   = new Map<string, PlacedEntity>();

    edges.forEach(edge => {
      const producers = entitiesForNode(obstacles, edge.from);
      const consumers = entitiesForNode(obstacles, edge.to);
      if (producers.length === 0 || consumers.length === 0) return;

      const total = edge.rate;
      const perConsumerRate = total / consumers.length;
      const perProducerRate = total / producers.length;

      // 1 → N (split)
      if (producers.length === 1 && consumers.length > 1) {
        const prod = producers[0];
        let split = splitterByProdId.get(prod.id);
        if (!split) {
          split = placeSplitterNear(prod, obstacles);
          splitterByProdId.set(prod.id, split);
          extras.push(split);
          obstacles.push(split);

          belts.push({
            id: Math.random().toString(36).slice(2,9),
            mk: minBeltMkFor(total),
            rate: total,
            segments: routeAvoidingMachines(outputPortOf(prod), inputPortOf(split), obstacles),
          });
        }

        consumers.forEach((cons, j) => {
          const outIdx = j % outputsCount(split!);
          belts.push({
            id: Math.random().toString(36).slice(2,9),
            mk: minBeltMkFor(perConsumerRate),
            rate: perConsumerRate,
            segments: routeAvoidingMachines(outputPortOf(split!, outIdx), inputPortOf(cons, edge.inputIndex), obstacles),
          });
        });
        return;
      }

      // N → 1 (merge)
      if (producers.length > 1 && consumers.length === 1) {
        const cons = consumers[0];
        let merge = mergerByConsId.get(cons.id);
        if (!merge) {
          merge = placeMergerNear(cons, obstacles);
          mergerByConsId.set(cons.id, merge);
          extras.push(merge);
          obstacles.push(merge);

          belts.push({
            id: Math.random().toString(36).slice(2,9),
            mk: minBeltMkFor(total),
            rate: total,
            segments: routeAvoidingMachines(outputPortOf(merge), inputPortOf(cons, edge.inputIndex), obstacles),
          });
        }

        producers.forEach((prod, j) => {
          const inIdx = j % inputsCount(merge!);
          belts.push({
            id: Math.random().toString(36).slice(2,9),
            mk: minBeltMkFor(perProducerRate),
            rate: perProducerRate,
            segments: routeAvoidingMachines(outputPortOf(prod), inputPortOf(merge!, inIdx), obstacles),
          });
        });
        return;
      }

      // N → N (split + merge)
      if (producers.length > 1 && consumers.length > 1) {
        const splitters = producers.map(prod => {
          let s = splitterByProdId.get(prod.id);
          if (!s) {
            s = placeSplitterNear(prod, obstacles);
            splitterByProdId.set(prod.id, s);
            extras.push(s);
            obstacles.push(s);
            belts.push({
              id: Math.random().toString(36).slice(2,9),
              mk: minBeltMkFor(perProducerRate),
              rate: perProducerRate,
              segments: routeAvoidingMachines(outputPortOf(prod), inputPortOf(s), obstacles),
            });
          }
          return s!;
        });

        const mergers = consumers.map(cons => {
          let m = mergerByConsId.get(cons.id);
          if (!m) {
            m = placeMergerNear(cons, obstacles);
            mergerByConsId.set(cons.id, m);
            extras.push(m);
            obstacles.push(m);
            belts.push({
              id: Math.random().toString(36).slice(2,9),
              mk: minBeltMkFor(perConsumerRate),
              rate: perConsumerRate,
              segments: routeAvoidingMachines(outputPortOf(m), inputPortOf(cons, edge.inputIndex), obstacles),
            });
          }
          return m!;
        });

        const rateSplitToMerge = total / Math.max(1, producers.length);
        splitters.forEach(s => {
          mergers.forEach((m, k) => {
            const outIdx = k % outputsCount(s);
            const inIdx  = 0; // merger: on utilise ses 3 entrées mais ici maillage simple
            belts.push({
              id: Math.random().toString(36).slice(2,9),
              mk: minBeltMkFor(rateSplitToMerge / mergers.length),
              rate: rateSplitToMerge / mergers.length,
              segments: routeAvoidingMachines(outputPortOf(s, outIdx), inputPortOf(m, inIdx), obstacles),
            });
          });
        });
        return;
      }

      // 1 → 1 direct
      const prod = producers[0], cons = consumers[0];
      belts.push({
        id: Math.random().toString(36).slice(2,9),
        mk: minBeltMkFor(total),
        rate: total,
        segments: routeAvoidingMachines(outputPortOf(prod), inputPortOf(cons, edge.inputIndex), obstacles),
      });
    });

    return { belts, extras };
  }

  /* ------------------------------ Action ------------------------------ */
  function runPlanner() {
    if (!targetItem) return;
    const chain = buildChain(targetItem, targetRate, preferAlt);
    if (!chain) return;

    const placement = autoLayout(chain, 8, 8);

    // Conserver les placements “manuels” (sans node) et remplacer les calculés
    const combined = entities.filter(e => !e.meta?.node).concat(placement);

    // Générer convoyeurs + splitters/mergers auto + routage A* (ports exacts)
    const { belts: newBelts, extras } = planBeltsWithJunctions(combined, chain);

    setEntities(combined.concat(extras));
    setBelts(newBelts);
  }

  /* ------------------------------ Rendu ------------------------------ */
  const bgStyle = useMemo(() => {
    const g = Math.max(1, gridStep);
    return {
      backgroundSize: `${scale * g}px ${scale * g}px, ${scale * FOUNDATION_M}px ${scale * FOUNDATION_M}px`,
      backgroundImage:
        `linear-gradient(to right, rgba(250,204,21,0.15) 1px, transparent 1px),
         linear-gradient(to bottom, rgba(250,204,21,0.15) 1px, transparent 1px),
         linear-gradient(to right, rgba(250,204,21,0.25) 1px, transparent 1px),
         linear-gradient(to bottom, rgba(250,204,21,0.25) 1px, transparent 1px)`,
      backgroundPosition: "0 0, 0 0, 0 0, 0 0",
      backgroundRepeat: "repeat, repeat, repeat, repeat",
    } as React.CSSProperties;
  }, [scale, gridStep]);

  return (
    <div className="w-full h-full bg-zinc-900 text-zinc-100">
      <header className="flex items-center gap-3 p-3 border-b border-zinc-800 sticky top-0 z-20 bg-zinc-900/80 backdrop-blur">
        <h1 className="text-xl font-semibold">Satisfactory Factory Planner — v2.8</h1>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="opacity-70">Zoom</span>
          <input type="range" min={4} max={26} step={1} value={scale} onChange={e => setScale(parseInt(e.target.value))} />
          <span className="w-10 text-right">{scale}px/m</span>

          <span className="ml-4 opacity-70">Snap</span>
          <select className="bg-zinc-800 rounded-md px-2 py-1" value={gridStep} onChange={e => setGridStep(parseInt(e.target.value))}>
            <option value={1}>1 m</option>
            <option value={2}>2 m</option>
            <option value={4}>4 m</option>
            <option value={8}>8 m (dalle)</option>
          </select>

          <button className={`ml-4 px-3 py-1 rounded-md border ${tool==="select"?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`} onClick={() => setTool("select")}>Sélection</button>
          <button className={`px-3 py-1 rounded-md border ${tool==="place"?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`} onClick={() => setTool("place")}>Placer</button>
          <button className={`px-3 py-1 rounded-md border ${tool==="belt"?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`} onClick={() => setTool("belt")} disabled>Convoyeur (bientôt)</button>
        </div>
      </header>

      <div className="grid grid-cols-[280px_1fr_320px] h-[calc(100vh-56px)]">
        {/* PALETTE */}
        <aside className="border-r border-zinc-800 p-3">
          <h2 className="text-sm uppercase tracking-wider opacity-70 mb-3">Palette</h2>
          <div className="grid grid-cols-2 gap-2">
            {Object.values(BUILDINGS).map(b => (
              <button
                key={b.id}
                onClick={() => { setPalette(b.id); setTool("place"); }}
                className={`rounded-xl border p-3 text-left hover:border-amber-400 ${palette===b.id?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`}
              >
                <div className="font-medium">{b.name}</div>
                <div className="text-xs opacity-70">{b.w}×{b.h} m</div>
              </button>
            ))}
          </div>

          <div className="mt-6">
            <h3 className="text-sm uppercase tracking-wider opacity-70 mb-2">Convoyeurs</h3>
            <div className="grid grid-cols-5 gap-2 text-xs">
              {BELT_SPEEDS.map((cap, i) => (
                <div key={i} className="rounded-lg border border-zinc-700 p-2 text-center">
                  Mk{i+1}<br/><span className="opacity-70">{cap}/min</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* BOARD */}
        <main className="relative overflow-auto" onClick={handleBoardClick}>
          <div ref={boardRef} className="relative min-w-[2200px] min-h={[1400].toString()} style" style={bgStyle as any}>
            <div className="absolute left-0 top-0 p-2 text-xs opacity-70">Origine (0,0) m</div>

            {/* Convoyeurs (bandes ambrées) */}
            {belts.map(belt =>
              belt.segments.map((s, i) => (
                <div
                  key={belt.id + ":" + i}
                  className="absolute"
                  title={`Mk${belt.mk} · ${Math.round(belt.rate*100)/100}/min`}
                  style={{
                    left: toPx(s.x),
                    top: toPx(s.y),
                    width: toPx(Math.max(0.1, s.w)),
                    height: toPx(Math.max(0.1, s.h)),
                    background: "rgba(250, 204, 21, 0.9)",
                    borderRadius: toPx(0.1),
                  }}
                />
              ))
            )}

            {/* Machines + jonctions */}
            {entities.map(e => {
              const w = e.meta?.w ?? 2;
              const h = e.meta?.h ?? 2;
              const inN = inputsCount(e);
              const outN = outputsCount(e);
              return (
                <div
                  key={e.id}
                  className={`absolute rounded-2xl shadow-md border ${e.type==="splitter"||e.type==="merger" ? "border-amber-500 bg-amber-500/10" : "border-zinc-700 bg-zinc-800/80"} backdrop-blur-sm hover:shadow-lg`}
                  title={
                    e.meta?.node
                      ? (() => {
                          const round2 = (v: number) => Math.round(v * 100) / 100;
                          const n: Node = e.meta.node;
                          const inputs = n.inputs.map(i => `${round2(i.rate)}/min ${i.name}`).join(" + ");
                          return `${n.name}: ${round2(n.outputRate)}/min\n${inputs}\nBelt ≥ Mk${minBeltMkFor(n.outputRate)}`;
                        })()
                      : BUILDINGS[e.type as BuildingId]?.name
                  }
                  style={{ left: toPx(e.x), top: toPx(e.y), width: toPx(w), height: toPx(h) }}
                >
                  <div className="text-[10px] leading-tight p-1 text-zinc-200 flex items-center justify-between">
                    <span>{BUILDINGS[e.type as BuildingId]?.name ?? "Belt"}</span>
                    <button className="opacity-70 hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); removeEntity(e.id); }}>✕</button>
                  </div>

                  {/* Ports visuels (Entrées à gauche / Sorties à droite) */}
                  {/* Entrées */}
                  {[...Array(inN)].map((_, i) => (
                    <div
                      key={`in-${i}`}
                      className="absolute bg-amber-300 rounded-full"
                      style={{
                        left: -4,
                        top: `calc(${((i + 1) * 100) / (inN + 1)}% - 3px)`,
                        width: 6,
                        height: 6,
                      }}
                      title="Entrée"
                    />
                  ))}
                  {/* Sorties */}
                  {[...Array(outN)].map((_, i) => (
                    <div
                      key={`out-${i}`}
                      className="absolute bg-amber-300 rounded-full"
                      style={{
                        right: -4,
                        top: `calc(${((i + 1) * 100) / (outN + 1)}% - 3px)`,
                        width: 6,
                        height: 6,
                      }}
                      title="Sortie"
                    />
                  ))}

                  {e.meta?.node && (
                    <div className="px-2 pb-1 text-[10px] text-zinc-300">
                      <div>{e.meta.node.name} · {Math.round(e.meta.node.outputRate*100)/100}/min</div>
                      <div>{Math.round(e.meta.node.machines*100)/100}×</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </main>

        {/* PLANNER */}
        <aside className="border-l border-zinc-800 p-3 space-y-3">
          <h2 className="text-sm uppercase tracking-wider opacity-70">Planificateur</h2>
          <div className="space-y-2">
            <label className="text-sm">Produit cible</label>
            <select className="w-full bg-zinc-800 rounded-md px-2 py-2" value={targetItem} onChange={(e)=> setTargetItem(e.target.value)}>
              <option value="">— Choisir —</option>
              {productList.map(name => (<option key={name} value={name}>{name}</option>))}
            </select>

            {targetItem && hasAlt && (
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={preferAlt} onChange={(e)=> setPreferAlt(e.target.checked)} />
                Utiliser recette alternative
              </label>
            )}

            <div className="flex items-center gap-2">
              <label className="text-sm">Débit (items/min)</label>
              <input className="bg-zinc-800 rounded-md px-2 py-1 w-24" type="number" min={1} value={targetRate} onChange={(e)=> setTargetRate(parseFloat(e.target.value))} />
            </div>

            <button onClick={runPlanner} className="w-full rounded-md border border-amber-400 bg-amber-400/10 py-2 hover:bg-amber-400/20">Générer le layout</button>
          </div>

          <div className="pt-4 border-t border-zinc-800 text-sm space-y-2">
            <h3 className="uppercase tracking-wider opacity-70">Notes</h3>
            <ul className="list-disc ml-5 space-y-1 opacity-90">
              <li>Placement anti-collision + marge {ENTITY_PADDING_M} m.</li>
              <li>Ports définis : entrées gauche, sorties droite (multi-ports selon type).</li>
              <li>Splitters/Mergers auto + routage A* depuis les ports.</li>
              <li>Recettes depuis <code>src/data/recipes.json</code>.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
