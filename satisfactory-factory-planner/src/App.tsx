import React, { useEffect, useMemo, useRef, useState } from "react";
import { FOUNDATION_M, BELT_SPEEDS, BUILDINGS } from "./data/constants";
import type { BuildingId, Recipe } from "./types";
import RECIPES_DATA from "./data/recipes.json";

type ToolType = "select" | "place" | "belt";

interface PlacedEntity {
  id: string;
  type: BuildingId | "belt";
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  meta?: any;
}

type Node = {
  name: string;
  recipeId: string;
  building: BuildingId;
  outputRate: number; // /min
  machines: number;
  inputs: { name: string; rate: number; from?: Node }[];
};

const DEFAULT_SCALE_PX_PER_M = 8;

export default function FactoryPlanner() {
  // UI state
  const [scale, setScale] = useState(DEFAULT_SCALE_PX_PER_M);
  const [gridStep, setGridStep] = useState(1);
  const [tool, setTool] = useState<ToolType>("select");
  const [palette, setPalette] = useState<BuildingId>("constructor");
  const [entities, setEntities] = useState<PlacedEntity[]>([]);

  // Recipes (data-driven)
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [productList, setProductList] = useState<string[]>([]);
  const [targetItem, setTargetItem] = useState<string>("");
  const [targetRate, setTargetRate] = useState<number>(15);
  const [preferAlt, setPreferAlt] = useState<boolean>(false);

  const boardRef = useRef<HTMLDivElement>(null);
  const toPx = (m: number) => Math.round(m * scale);
  const snapToGrid = (m: number) => Math.round(m / gridStep) * gridStep;

  // Load recipes once (import JSON -> state)
  useEffect(() => {
    const data = RECIPES_DATA as Recipe[];
    setRecipes(data);
    // unique product names (liste principale sans doublons)
    const uniques = Array.from(new Set(data.map(r => r.product.name)));
    setProductList(uniques.sort());
  }, []);

  // For the selected product, check if an alt exists
  const hasAlt = useMemo(() => {
    if (!targetItem) return false;
    const candidates = recipes.filter(r => r.product.name === targetItem);
    return candidates.some(r => r.alt);
  }, [recipes, targetItem]);

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

  // Find recipe by product name (+ alt toggle)
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

    // recurse only if we also know how to craft the input
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
          placements.push({ id: Math.random().toString(36).slice(2, 9), type: node.building, x: px, y: py, rotation: 0, meta: { w: spec.w, h: spec.h, node } });
          placed++;
        }
        x += (perRow * (spec.w + spacing)) + 8;
      });
      y += 12;
    });
    return placements;
  }

  function tooltipForNode(n: Node) {
    const round2 = (v: number) => Math.round(v * 100) / 100;
    const inputs = n.inputs.map(i => `${round2(i.rate)}/min ${i.name}`).join(" + ");
    return `${n.name}: ${round2(n.outputRate)}/min\n${inputs}\nBelt ≥ Mk${minBeltMkFor(n.outputRate)}`;
  }

  function runPlanner() {
    if (!targetItem) return;
    const chain = buildChain(targetItem, targetRate, preferAlt);
    if (!chain) return;
    const placement = autoLayout(chain, 8, 8);
    setEntities(prev => prev.filter(e => !e.meta?.node).concat(placement));
  }

  // grid background sizes
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
        <h1 className="text-xl font-semibold">Satisfactory Factory Planner — v2 (data-driven)</h1>
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
              <button key={b.id} onClick={() => { setPalette(b.id); setTool("place"); }} className={`rounded-xl border p-3 text-left hover:border-amber-400 ${palette===b.id?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`}>
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
            {entities.map(e => (
              <div
                key={e.id}
                className="absolute rounded-2xl shadow-md border border-zinc-700 bg-zinc-800/80 backdrop-blur-sm hover:shadow-lg"
                title={e.meta?.node ? tooltipForNode(e.meta.node) : (BUILDINGS as any)[e.type as BuildingId]?.name}
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
              <li>Recettes chargées depuis <code>recipes.json</code>.</li>
              <li>Si tu ajoutes des recettes, elles apparaissent automatiquement.</li>
              <li>Prochaines étapes : routage auto des convoyeurs, ports I/O exacts, électricité.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
