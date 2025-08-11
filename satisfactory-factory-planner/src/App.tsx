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

type Rotation = 0 | 90 | 180 | 270;

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
  rotation: Rotation; // 0 = IN gauche / OUT droite
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
type Belt = {
  id: string;
  mk: number;
  rate: number;
  item: string;
  color: string;
  segments: BeltSegment[];
};

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

const DEFAULT_SCALE_PX_PER_M = 15;
const PATH_GRID_M = 1;
const BELT_THICKNESS_M = 0.3;
const CLEARANCE_M = 0.6;
const START_END_FREE_RADIUS = 1;
const ENTITY_PADDING_M = 0.4;

// Routage directionnel (gauche→droite), on garde mais on ajoute un "biais"
const WEST_PENALTY = 8;
const TURN_PENALTY = 0.7;
const VERT_PENALTY = 0.05;

// Bus
const BUS_SPACING = 8;           // 1 dalle entre bus
const BUS_MARGIN = 0.5;          // pour test de collision du bus
type BusMap = Map<string, number>; // item -> y

/* ======================= Composant principal ======================= */
export default function FactoryPlanner() {
  // UI
  const [scale, setScale] = useState(DEFAULT_SCALE_PX_PER_M);
  const [gridStep, setGridStep] = useState(1);
  const [tool, setTool] = useState<ToolType>("select");
  const [palette, setPalette] = useState<BuildingId>("constructor");
  const [placingRotation, setPlacingRotation] = useState<Rotation>(0);
  const [entities, setEntities] = useState<PlacedEntity[]>([]);
  const [belts, setBelts] = useState<Belt[]>([]);
  const [buses, setBuses] = useState<{item: string; y: number; color: string}[]>([]);

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

  // Raccourci clavier "R" pour la rotation de placement
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "r") {
        setPlacingRotation(prev => (prev === 270 ? 0 : ((prev + 90) as Rotation)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      addEntity({ type: palette, x: pos.x, y: pos.y, rotation: placingRotation, meta: { w: spec.w, h: spec.h } });
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

    // colonnes fixées pour garder des rues verticales
    const COLUMN_GAP = 12; // plus large = plus de place pour les bus
    let yBase = originY;
    const placements: PlacedEntity[] = [];
    const obstacles: PlacedEntity[] = [];

    layers.slice().reverse().forEach(nodes => {
      let x = originX;
      nodes.forEach(node => {
        const spec = BUILDINGS[node.building];
        const count = Math.ceil(node.machines * 100) / 100;
        const spacing = 2; // m
        const perRow = Math.max(1, Math.floor((FOUNDATION_M * 5.5) / (spec.w + spacing)));
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
        // large gap entre groupes pour les couloirs / bus
        x += (perRow * (spec.w + spacing)) + COLUMN_GAP;
      });
      yBase += 12;
    });
    return placements;
  }

  /* ================ Routage A* (avec biais orienté) ================= */
  function pointInRect(px: number, py: number, r: Rect) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  type AxisBias = "none" | "preferHorizontal" | "preferVertical";

  // A* sur grille 1 m, 4 directions, évite obstacles, coûte selon la direction et un biais axe.
  function routeDirectionalWithBias(
    start: {x:number;y:number},
    end: {x:number;y:number},
    ens: PlacedEntity[],
    bias: AxisBias
  ): BeltSegment[] {
    const obstacles = ens.map(rectOfEntity).map(r => expandRect(r, CLEARANCE_M));

    const xs = [start.x, end.x, ...obstacles.map(r=>r.x), ...obstacles.map(r=>r.x+r.w)];
    const ys = [start.y, end.y, ...obstacles.map(r=>r.y), ...obstacles.map(r=>r.y+r.h)];
    let minX = Math.floor(Math.min(...xs) - 8);
    let maxX = Math.ceil (Math.max(...xs) + 8);
    let minY = Math.floor(Math.min(...ys) - 8);
    let maxY = Math.ceil (Math.max(...ys) + 8);

    const cols = Math.max(1, Math.round((maxX - minX) / PATH_GRID_M));
    const rows = Math.max(1, Math.round((maxY - minY) / PATH_GRID_M));

    function toGridX(x:number){ return Math.round((x - minX) / PATH_GRID_M); }
    function toGridY(y:number){ return Math.round((y - minY) / PATH_GRID_M); }
    function toWorldX(gx:number){ return minX + gx * PATH_GRID_M; }
    function toWorldY(gy:number){ return minY + gy * PATH_GRID_M; }

    const sGX = toGridX(start.x), sGY = toGridY(start.y);
    const eGX = toGridX(end.x),   eGY = toGridY(end.y);

    function collides(cx:number, cy:number) {
      if (Math.hypot(cx - start.x, cy - start.y) <= START_END_FREE_RADIUS) return false;
      if (Math.hypot(cx - end.x,   cy - end.y)   <= START_END_FREE_RADIUS) return false;
      for (const r of obstacles) {
        if (pointInRect(cx, cy, r)) return true;
      }
      return false;
    }

    type OpenNode = { f:number; gx:number; gy:number; dir:number };
    const open: OpenNode[] = [];
    const gScore = new Map<string, number>();
    const came   = new Map<string, string>();
    function key(gx:number,gy:number){ return `${gx},${gy}`; }

    const sKey = key(sGX,sGY);
    gScore.set(sKey, 0);
    open.push({ f: Math.abs(sGX-eGX)+Math.abs(sGY-eGY), gx: sGX, gy: sGY, dir: 0 });

    const inBounds = (gx:number, gy:number) => gx>=0 && gx<cols && gy>=0 && gy<rows;

    let foundKey: string | null = null;
    while (open.length) {
      open.sort((a,b)=>a.f-b.f);
      const cur = open.shift()!;
      const k = key(cur.gx,cur.gy);
      if (cur.gx === eGX && cur.gy === eGY) { foundKey = k; break; }

      const neigh: Array<[number,number,number]> = [
        [ 1, 0, 0], // east
        [-1, 0, 1], // west
        [ 0,-1, 2], // north
        [ 0, 1, 3], // south
      ];
      for (const [dx,dy,ndir] of neigh) {
        const ngx = cur.gx+dx, ngy = cur.gy+dy;
        if (!inBounds(ngx,ngy)) continue;
        const cx = toWorldX(ngx), cy = toWorldY(ngy);
        if (collides(cx,cy)) continue;

        let stepCost = 1;
        // Directionnel gauche→droite
        if (ndir === 1) stepCost += WEST_PENALTY;
        if (ndir === 2 || ndir === 3) stepCost += VERT_PENALTY;
        if (ndir !== cur.dir) stepCost += TURN_PENALTY;

        // Biais d'axe
        if (bias === "preferHorizontal" && (ndir === 2 || ndir === 3)) stepCost += 0.7;
        if (bias === "preferVertical"   && (ndir === 0 || ndir === 1)) stepCost += 0.7;

        const nk = key(ngx,ngy);
        const tentative = (gScore.get(k) ?? Infinity) + stepCost;
        if (tentative < (gScore.get(nk) ?? Infinity)) {
          came.set(nk, k);
          gScore.set(nk, tentative);
          // heuristique: distance + petit biais vers l'est
          const h = Math.abs(ngx - eGX) + Math.abs(ngy - eGY) + Math.max(0, (eGX - ngx)) * 0.05;
          const f = tentative + h;
          const idx = open.findIndex(t => t.gx===ngx && t.gy===ngy);
          if (idx === -1 || open[idx].f > f) {
            if (idx !== -1) open.splice(idx,1);
            open.push({ f, gx: ngx, gy: ngy, dir: ndir });
          }
        }
      }
    }

    if (!foundKey) return routeManhattan(start, end);

    // Reconstruit
    const cells: Array<{x:number;y:number}> = [];
    let curKey = key(eGX,eGY);
    while (curKey !== sKey) {
      const [gx,gy] = curKey.split(",").map(Number);
      cells.push({ x: toWorldX(gx), y: toWorldY(gy) });
      curKey = came.get(curKey)!;
      if (!curKey) break;
    }
    cells.push({ x: start.x, y: start.y });
    cells.reverse();

    // Compresse
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

  // L “Manhattan” de secours
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
  function inputsCount(e: PlacedEntity) {
    if (e.type === "merger") return 3;
    if (e.meta?.node?.inputs?.length) return e.meta.node.inputs.length;
    return BUILDINGS[e.type as BuildingId]?.inputs ?? 1;
  }
  function outputsCount(e: PlacedEntity) {
    if (e.type === "splitter") return 3;
    return BUILDINGS[e.type as BuildingId]?.outputs ?? 1;
  }

  function inputSide(rot: Rotation): "left" | "top" | "right" | "bottom" {
    switch (rot) {
      case 0: return "left";
      case 90: return "top";
      case 180: return "right";
      case 270: return "bottom";
    }
  }
  function outputSide(rot: Rotation): "left" | "top" | "right" | "bottom" {
    switch (rot) {
      case 0: return "right";
      case 90: return "bottom";
      case 180: return "left";
      case 270: return "top";
    }
  }

  function portOnSide(e: PlacedEntity, side: "left"|"top"|"right"|"bottom", idx:number, count:number) {
    const w = e.meta?.w ?? 2, h = e.meta?.h ?? 2;
    if (side === "left")  return { x: e.x,      y: e.y + ((idx + 1) * (h / (count + 1))) };
    if (side === "right") return { x: e.x + w,  y: e.y + ((idx + 1) * (h / (count + 1))) };
    if (side === "top")   return { x: e.x + ((idx + 1) * (w / (count + 1))), y: e.y };
    return { x: e.x + ((idx + 1) * (w / (count + 1))), y: e.y + h };
  }
  function inputPortOf(e: PlacedEntity, idx = 0) {
    return portOnSide(e, inputSide(e.rotation), idx, Math.max(1, inputsCount(e)));
  }
  function outputPortOf(e: PlacedEntity, idx = 0) {
    return portOnSide(e, outputSide(e.rotation), idx, Math.max(1, outputsCount(e)));
  }

  function portDotStyle(e: PlacedEntity, side: "left"|"top"|"right"|"bottom", idx:number, count:number): React.CSSProperties {
    const posPercent = ((idx + 1) * 100) / (count + 1);
    const s: React.CSSProperties = { position: "absolute", width: 6, height: 6, borderRadius: 9999 };
    if (side === "left") { s.left = -4; s.top = `calc(${posPercent}% - 3px)`; }
    if (side === "right") { s.right = -4; s.top = `calc(${posPercent}% - 3px)`; }
    if (side === "top") { s.top = -4; s.left = `calc(${posPercent}% - 3px)`; }
    if (side === "bottom") { s.bottom = -4; s.left = `calc(${posPercent}% - 3px)`; }
    return s;
  }

  /* ------------------- Splitters/Mergers & planification ------------------- */
  function collectEdges(root: Node) {
    const edges: { from: Node; to: Node; inputIndex: number; rate: number; item: string }[] = [];
    (function dfs(n: Node) {
      n.inputs.forEach((inp, i) => {
        if (inp.from) {
          edges.push({ from: inp.from, to: n, inputIndex: i, rate: inp.rate, item: inp.name });
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

  function colorForItem(name: string) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `hsl(${hue} 85% 55%)`;
  }

  /* =====================  BUS DE RESSOURCE (v3.1)  ===================== */
  // Teste si un segment horizontal à y traverse un obstacle
  function horizontalBlocked(y:number, x1:number, x2:number, obs: PlacedEntity[]) {
    const a = Math.min(x1,x2), b = Math.max(x1,x2);
    for (const o of obs) {
      const r = expandRect(rectOfEntity(o), BUS_MARGIN);
      if (y >= r.y && y <= r.y + r.h) {
        const ox1 = r.x, ox2 = r.x + r.w;
        if (!(b <= ox1 || a >= ox2)) return true;
      }
    }
    return false;
  }

  // Calcule/choisit une altitude de bus pour l’item, espacée et libre
  function ensureBusY(item: string, color: string, obs: PlacedEntity[], xRange:[number,number], buses: BusMap) {
    if (buses.has(item)) return buses.get(item)!;
    const [minX, maxX] = xRange;
    // baseY = plus petit y des obstacles, puis on essaye tous les 8m
    const ys = obs.flatMap(o => [o.y, o.y + (o.meta?.h ?? 2)]);
    const base = Math.floor((Math.min(...ys) || 0) + FOUNDATION_M/2);
    for (let k = 0; k < 100; k++) {
      const y = snapToGrid(base + k*BUS_SPACING);
      if (!horizontalBlocked(y, minX, maxX, obs)) {
        buses.set(item, y);
        return y;
      }
    }
    // si on ne trouve pas de couloir complètement libre, on prend quand même le premier
    const y = snapToGrid(base);
    buses.set(item, y);
    return y;
  }

  // Route en 3 jambes via bus (V → H → V) avec A* biaisé
  function routeViaBus(
    start:{x:number;y:number},
    end:{x:number;y:number},
    item:string,
    color:string,
    obs:PlacedEntity[],
    xRange:[number,number],
    busMap:BusMap
  ): BeltSegment[] {
    const busY = ensureBusY(item, color, obs, xRange, busMap);

    const leg1 = routeDirectionalWithBias(start, {x:start.x, y:busY}, obs, "preferVertical");
    const leg2 = routeDirectionalWithBias({x:start.x, y:busY}, {x:end.x, y:busY}, obs, "preferHorizontal");
    const leg3 = routeDirectionalWithBias({x:end.x, y:busY}, end, obs, "preferVertical");

    // merge segments (éviter 0-longueur)
    const merged: BeltSegment[] = [];
    for (const seg of [...leg1, ...leg2, ...leg3]) {
      if (seg.w <= 0.0001 && seg.h <= 0.0001) continue;
      const last = merged[merged.length-1];
      if (last) {
        const horiz = Math.abs(last.h - BELT_THICKNESS_M) < 1e-6 && Math.abs(seg.h - BELT_THICKNESS_M) < 1e-6 && Math.abs(last.y - seg.y) < 1e-6;
        const vert  = Math.abs(last.w - BELT_THICKNESS_M) < 1e-6 && Math.abs(seg.w - BELT_THICKNESS_M) < 1e-6 && Math.abs(last.x - seg.x) < 1e-6;
        if (horiz && (Math.abs(last.x + last.w - seg.x) < 1e-6)) { last.w += seg.w; continue; }
        if (vert  && (Math.abs(last.y + last.h - seg.y) < 1e-6)) { last.h += seg.h; continue; }
      }
      merged.push({...seg});
    }
    return merged;
  }

  function planBeltsWithJunctions(allEntities: PlacedEntity[], root: Node) {
    const edges = collectEdges(root);
    const belts: Belt[] = [];
    const extras: PlacedEntity[] = [];
    const obstacles: PlacedEntity[] = [...allEntities];

    // bornes X pour tracer les bus d’un bord à l’autre
    const xs = obstacles.flatMap(o => [o.x, o.x + (o.meta?.w ?? 2)]);
    const minX = Math.min(...xs) - 6;
    const maxX = Math.max(...xs) + 18;
    const xRange:[number,number] = [minX, maxX];

    const splitterByProdId = new Map<string, PlacedEntity>();
    const mergerByConsId   = new Map<string, PlacedEntity>();
    const busMap: BusMap = new Map(); // item -> y
    const busVis: {item:string; y:number; color:string}[] = [];

    const getBusColor = (name:string) => colorForItem(name);

    edges.forEach(edge => {
      const producers = entitiesForNode(obstacles, edge.from);
      const consumers = entitiesForNode(obstacles, edge.to);
      if (producers.length === 0 || consumers.length === 0) return;

      const total = edge.rate;
      const perConsumerRate = total / consumers.length;
      const perProducerRate = total / producers.length;
      const color = getBusColor(edge.item);
      const busY = ensureBusY(edge.item, color, obstacles, xRange, busMap);
      // mémoriser pour affichage
      if (!busVis.find(b => b.item === edge.item)) busVis.push({item: edge.item, y: busY, color});

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
            item: edge.item,
            color,
            segments: routeViaBus(outputPortOf(prod), inputPortOf(split), edge.item, color, obstacles, xRange, busMap),
          });
        }

        consumers.forEach((cons, j) => {
          const outIdx = j % outputsCount(split!);
          belts.push({
            id: Math.random().toString(36).slice(2,9),
            mk: minBeltMkFor(perConsumerRate),
            rate: perConsumerRate,
            item: edge.item,
            color,
            segments: routeViaBus(outputPortOf(split!, outIdx), inputPortOf(cons, edge.inputIndex), edge.item, color, obstacles, xRange, busMap),
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
            item: edge.item,
            color,
            segments: routeViaBus(outputPortOf(merge), inputPortOf(cons, edge.inputIndex), edge.item, color, obstacles, xRange, busMap),
          });
        }

        producers.forEach((prod, j) => {
          const inIdx = j % inputsCount(merge!);
          belts.push({
            id: Math.random().toString(36).slice(2,9),
            mk: minBeltMkFor(perProducerRate),
            rate: perProducerRate,
            item: edge.item,
            color,
            segments: routeViaBus(outputPortOf(prod), inputPortOf(merge!, inIdx), edge.item, color, obstacles, xRange, busMap),
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
              item: edge.item,
              color,
              segments: routeViaBus(outputPortOf(prod), inputPortOf(s), edge.item, color, obstacles, xRange, busMap),
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
              item: edge.item,
              color,
              segments: routeViaBus(outputPortOf(m), inputPortOf(cons, edge.inputIndex), edge.item, color, obstacles, xRange, busMap),
            });
          }
          return m!;
        });

        const rateSplitToMerge = total / Math.max(1, producers.length);
        splitters.forEach(s => {
          mergers.forEach((m, k) => {
            const outIdx = k % outputsCount(s);
            belts.push({
              id: Math.random().toString(36).slice(2,9),
              mk: minBeltMkFor(rateSplitToMerge / mergers.length),
              rate: rateSplitToMerge / mergers.length,
              item: edge.item,
              color,
              segments: routeViaBus(outputPortOf(s, outIdx), inputPortOf(m, 0), edge.item, color, obstacles, xRange, busMap),
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
        item: edge.item,
        color,
        segments: routeViaBus(outputPortOf(prod), inputPortOf(cons, edge.inputIndex), edge.item, color, obstacles, xRange, busMap),
      });
    });

    return { belts, extras, buses: busVis };
  }

  /* ------------------------------ Action ------------------------------ */
  function runPlanner() {
    if (!targetItem) return;
    const chain = buildChain(targetItem, targetRate, preferAlt);
    if (!chain) return;

    const placement = autoLayout(chain, 8, 8);

    const combined = entities.filter(e => !e.meta?.node).concat(placement);

    const { belts: newBelts, extras, buses } = planBeltsWithJunctions(combined, chain);

    setEntities(combined.concat(extras));
    setBelts(newBelts);
    setBuses(buses);
  }

  /* ------------------------------ Rendu ------------------------------ */
  const bgStyle = useMemo(() => {
    const g = Math.max(1, gridStep);
    return {
      backgroundSize: `${scale * g}px ${scale * g}px, ${scale * FOUNDATION_M}px ${scale * FOUNDATION_M}px`,
      backgroundImage:
        `linear-gradient(to right, rgba(250,204,21,0.12) 1px, transparent 1px),
         linear-gradient(to bottom, rgba(250,204,21,0.12) 1px, transparent 1px),
         linear-gradient(to right, rgba(250,204,21,0.25) 1px, transparent 1px),
         linear-gradient(to bottom, rgba(250,204,21,0.25) 1px, transparent 1px)`,
      backgroundPosition: "0 0, 0 0, 0 0, 0 0",
      backgroundRepeat: "repeat, repeat, repeat, repeat",
    } as React.CSSProperties;
  }, [scale, gridStep]);

  return (
    <div className="w-full h-full bg-zinc-900 text-zinc-100">
      <header className="flex items-center gap-3 p-3 border-b border-zinc-800 sticky top-0 z-20 bg-zinc-900/80 backdrop-blur">
        <h1 className="text-xl font-semibold">Satisfactory Factory Planner — v3.1</h1>
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

          <span className="ml-4 opacity-70">Rotation</span>
          <button
            className="px-3 py-1 rounded-md border border-zinc-700 hover:border-amber-400"
            onClick={() => setPlacingRotation(prev => (prev === 270 ? 0 : ((prev + 90) as Rotation)))}
            title="Raccourci clavier: R"
          >
            {placingRotation}°
          </button>

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
          <div ref={boardRef} className="relative min-w-[2400px] min-h-[1400px]" style={bgStyle}>
            <div className="absolute left-0 top-0 p-2 text-xs opacity-70">Origine (0,0) m</div>

            {/* BUS (traits discrets en fond) */}
            {buses.map((b) => (
              <div
                key={`bus-${b.item}`}
                className="absolute"
                title={`Bus ${b.item}`}
                style={{
                  left: 0,
                  top: toPx(b.y - 0.05),
                  width: "200%",
                  height: toPx(0.1),
                  background: b.color,
                  opacity: 0.35,
                }}
              />
            ))}

            {/* Convoyeurs (couleurs par ressource) */}
            {belts.map(belt =>
              belt.segments.map((s, i) => (
                <div
                  key={belt.id + ":" + i}
                  className="absolute"
                  title={`${belt.item} · Mk${belt.mk} · ${Math.round(belt.rate*100)/100}/min`}
                  style={{
                    left: toPx(s.x),
                    top: toPx(s.y),
                    width: toPx(Math.max(0.1, s.w)),
                    height: toPx(Math.max(0.1, s.h)),
                    background: belt.color,
                    borderRadius: toPx(0.1),
                    boxShadow: `0 0 ${toPx(0.1)}px ${belt.color}`,
                  }}
                />
              ))
            )}
            {/* Étiquette au milieu de chaque ligne */}
            {belts.map((belt) => {
              if (!belt.segments.length) return null;
              const s = belt.segments[Math.floor(belt.segments.length/2)];
              const cx = s.x + s.w/2;
              const cy = s.y + s.h/2;
              return (
                <div
                  key={belt.id + ":label"}
                  className="absolute text-[10px] px-1 py-px rounded"
                  style={{
                    left: toPx(cx) - 20,
                    top: toPx(cy) - 10,
                    background: "rgba(0,0,0,0.55)",
                    color: belt.color,
                    border: `1px solid ${belt.color}`,
                    pointerEvents: "none",
                  }}
                >
                  {belt.item}
                </div>
              );
            })}

            {/* Machines + jonctions */}
            {entities.map(e => {
              const w = e.meta?.w ?? 2;
              const h = e.meta?.h ?? 2;
              const inN = inputsCount(e);
              const outN = outputsCount(e);
              const inSideName = inputSide(e.rotation);
              const outSideName = outputSide(e.rotation);

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
                    <div className="flex items-center gap-1">
                      <span className="opacity-60">{e.rotation}°</span>
                      <button className="opacity-70 hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); removeEntity(e.id); }}>✕</button>
                    </div>
                  </div>

                  {/* Ports visibles : IN verts, OUT rouges */}
                  {[...Array(inN)].map((_, i) => (
                    <div
                      key={`in-${i}`}
                      className="absolute"
                      style={{ ...portDotStyle(e, inSideName, i, inN), background: "#22c55e" }}
                      title="Entrée"
                    />
                  ))}
                  {[...Array(outN)].map((_, i) => (
                    <div
                      key={`out-${i}`}
                      className="absolute"
                      style={{ ...portDotStyle(e, outSideName, i, outN), background: "#ef4444" }}
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
              <li>Routage via <strong>bus par ressource</strong> (V→H→V) avec A* biaisé.</li>
              <li>IN verts, OUT rouges. Convoyeurs colorés par ressource + étiquette.</li>
              <li>Placement anti-collision + colonnes espacées (“rues”).</li>
              <li>Split/Merge auto, recettes: <code>src/data/recipes.json</code>.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
