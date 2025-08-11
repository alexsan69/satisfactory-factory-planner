import React, { useEffect, useMemo, useRef, useState } from "react";
import RECIPES_DATA from "./data/recipes.json";

// ---------- Types & constantes locales (self-contained) ----------
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
  x: number; // en mètres
  y: number; // en mètres
  rotation: 0 | 90 | 180 | 270;
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

type BeltSegment = { x: number; y: number; w: number; h: number }; // en mètres
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

const DEFAULT_SCALE_PX_PER_M = 8;

// ======================= Composant principal =======================
export default function FactoryPlanner() {
  // --- UI ---
  const [scale, setScale] = useState(DEFAULT_SCALE_PX_PER_M);
  const [gridStep, setGridStep] = useState(1);
  const [tool, setTool] = useState<ToolType>("select");
  const [palette, setPalette] = useState<BuildingId>("constructor");
  const [entities, setEntities] = useState<PlacedEntity[]>([]);
  const [belts, setBelts] = useState<Belt[]>([]);

  // --- Data recettes ---
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [productList, setProductList] = useState<string[]>([]);
  const [targetItem, setTargetItem] = useState<string>("");
  const [targetRate, setTargetRate] = useState<number>(15);
  const [preferAlt, setPreferAlt] = useState<boolean>(false);

  const boardRef = useRef<HTMLDivElement>(null);

  // Helpers
  const toPx = (m: number) => Math.round(m * scale);
  const snapToGrid = (m: number) => Math.round(m / gridStep) * gridStep;

  // Charger recettes (JSON)
  useEffect(() => {
    const data = RECIPES_DATA as Recipe[];
    setRecipes(data);
    const uniques = Array.from(new Set(data.map(r => r.product.name)));
    setProductList(uniques.sort());
  }, []);

  // Y a-t-il une recette alternative pour le produit choisi ?
  const hasAlt = useMemo(() => {
    if (!targetItem) return false;
    const candidates = recipes.filter(r => r.product.name === targetItem);
    return candidates.some(r => r.alt);
  }, [recipes, targetItem]);

  // -------------------------- Interactions --------------------------
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
      addEntity({ type: palette, x, y, rotation: 0, meta: { w: spec.w, h: spec.h } });
    }
  }

  // -------------------- Planificateur (graph) -----------------------
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

  // ---------------------- Auto-layout machines ----------------------
  function autoLayout(root: Node, originX = 0, originY = 0) {
    const layers: Node[][] = [];
    function traverse(n: Node, depth: number) {
      if (!layers[depth]) layers[depth] = [];
      if (!layers[depth].includes(n)) layers[depth].push(n);
      n.inputs.forEach(i => { if (i.from) traverse(i.from, depth + 1); });
    }
    traverse(root, 0);

    let y = originY;
    const placements: PlacedEntity[] = [];
    layers.slice().reverse().forEach(nodes => {
      let x = originX;
      nodes.forEach(node => {
        const spec = BUILDINGS[node.building];
        const count = Math.ceil(node.machines * 100) / 100;
        const spacing = 2;
        const perRow = Math.max(1, Math.floor((FOUNDATION_M * 6) / (spec.w + spacing)));
        let placed = 0;
        while (placed < Math.ceil(count)) {
          const col = placed % perRow;
          const row = Math.floor(placed / perRow);
          const px = snapToGrid(x + col * (spec.w + spacing));
          const py = snapToGrid(y + row * (spec.h + spacing));
          placements.push({
            id: Math.random().toString(36).slice(2, 9),
            type: node.building,
            x: px,
            y: py,
            rotation: 0,
            meta: { w: spec.w, h: spec.h, node },
          });
          placed++;
        }
        x += (perRow * (spec.w + spacing)) + 8; // +1 fondation entre groupes
      });
      y += 12;
    });
    return placements;
  }

  // -------------------- Routage “Manhattan” v2.5 --------------------
  function findEntityForNode(ens: PlacedEntity[], node: Node | undefined) {
    if (!node) return undefined;
    return ens.find(e => e.meta?.node?.recipeId === node.recipeId);
  }
  function outputPortOf(e: PlacedEntity) {
    const w = e.meta?.w ?? 2; const h = e.meta?.h ?? 2;
    return { x: e.x + w, y: e.y + h / 2 };
  }
  function inputPortOf(e: PlacedEntity, idx = 0) {
    const w = e.meta?.w ?? 2; const h = e.meta?.h ?? 2;
    const slots = Math.max(1, (e.meta?.node?.inputs?.length ?? 1));
    const y = e.y + ((idx + 1) * (h / (slots + 1)));
    return { x: e.x, y };
  }
  function routeManhattan(a: {x:number;y:number}, b: {x:number;y:number}, grid=1): BeltSegment[] {
    const t = 0.3; // épaisseur (m)
    const midX = Math.round(((a.x + b.x) / 2) / grid) * grid;
    const segs: BeltSegment[] = [];
    // h1
    const x1 = Math.min(a.x, midX), x2 = Math.max(a.x, midX);
    segs.push({ x: x1, y: a.y - t/2, w: x2 - x1, h: t });
    // v
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    segs.push({ x: midX - t/2, y: y1, w: t, h: y2 - y1 });
    // h2
    const x3 = Math.min(midX, b.x), x4 = Math.max(midX, b.x);
    segs.push({ x: x3, y: b.y - t/2, w: x4 - x3, h: t });
    return segs;
  }
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
  function planBelts(allEntities: PlacedEntity[], root: Node) {
    const edges = collectEdges(root);
    const arr: Belt[] = [];
    edges.forEach(edge => {
      const prod = findEntityForNode(allEntities, edge.from);
      const cons = findEntityForNode(allEntities, edge.to);
      if (!prod || !cons) return;
      const start = outputPortOf(prod);
      const end = inputPortOf(cons, edge.inputIndex);
      const segments = routeManhattan(start, end, 1);
      const mk = minBeltMkFor(edge.rate);
      arr.push({ id: Math.random().toString(36).slice(2,9), mk, rate: edge.rate, segments });
    });
    return arr;
  }

  // ------------------------- Action planner -------------------------
  function runPlanner() {
    if (!targetItem) return;
    const chain = buildChain(targetItem, targetRate, preferAlt);
    if (!chain) return;

    const placement = autoLayout(chain, 8, 8);

    // Conserve les entités “manuelles” (sans meta.node), remplace les groupes calculés
    const combined = entities.filter(e => !e.meta?.node).concat(placement);
    setEntities(combined);

    // Génère les convoyeurs entre groupes (v2.5)
    const b = planBelts(combined, chain);
    setBelts(b);
  }

  // --------------------------- Rendu UI -----------------------------
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
        <h1 className="text-xl font-semibold">Satisfactory Factory Planner — v2.5</h1>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="opacity-70">Zoom</span>
          <input type="range" min={4} max={20} step={1} value={scale} onChange={e => setScale(parseInt(e.target.value))} />
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
          <div ref={boardRef} className="relative min-w-[2000px] min-h-[1200px]" style={bgStyle}>
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
                    background: "rgba(250, 204, 21, 0.8)",
                    borderRadius: toPx(0.1),
                  }}
                />
              ))
            )}

            {/* Machines */}
            {entities.map(e => (
              <div
                key={e.id}
                className="absolute rounded-2xl shadow-md border border-zinc-700 bg-zinc-800/80 backdrop-blur-sm hover:shadow-lg"
                title={
                  e.meta?.node
                    ? (() => {
                        const round2 = (v: number) => Math.round(v * 100) / 100;
                        const n: Node = e.meta.node;
                        const inputs = n.inputs.map(i => `${round2(i.rate)}/min ${i.name}`).join(" + ");
                        return `${n.name}: ${round2(n.outputRate)}/min\n${inputs}\nBelt ≥ Mk${minBeltMkFor(n.outputRate)}`;
                      })()
                    : (BUILDINGS as any)[e.type as BuildingId]?.name
                }
                style={{ left: toPx(e.x), top: toPx(e.y), width: toPx(e.meta?.w ?? 2), height: toPx(e.meta?.h ?? 2) }}
              >
                <div className="text-[10px] leading-tight p-1 text-zinc-200 flex items-center justify-between">
                  <span>{(BUILDINGS as any)[e.type]?.name ?? "Belt"}</span>
                  <button className="opacity-70 hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); removeEntity(e.id); }}>✕</button>
                </div>
                {e.meta?.node && (
                  <div className="px-2 pb-1 text-[10px] text-zinc-300">
                    <div>{e.meta.node.name} · {Math.round(e.meta.node.outputRate*100)/100}/min</div>
                    <div>{Math.round(e.meta.node.machines*100)/100}×</div>
                  </div>
                )}
              </div>
            ))}
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
              <li>Recettes chargées depuis <code>src/data/recipes.json</code>.</li>
              <li>Convoyeurs auto : tracé Manhattan simple + Mk minimal.</li>
              <li>À venir : splitters/mergers auto, évitement d’obstacles, électricité.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
