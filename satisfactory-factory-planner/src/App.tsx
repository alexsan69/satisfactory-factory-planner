import React, { useMemo, useRef, useState } from "react";


/**
 * Satisfactory Factory Planner — MVP
 * -------------------------------------------------------------
 * Goals
 * - Grille d'usines fidèle au jeu (mètres, dalles 8×8 m, sous-grilles 1/2/4 m)
 * - Placement d'éléments (machines, splitters/mergers, convoyeurs) avec snap
 * - Planificateur intelligent: à partir d'un objectif (ex: 15 RIP/min),
 *   calcule les débits, le nombre de machines et propose une ébauche de layout
 * - Vérification de débit convoyeurs et proposition du Mk minimal
 * - Tout est data‑driven: en important un JSON de recettes complet,
 *   toutes les combinaisons deviennent réalisables
 *
 * ⚠️ Ceci est un MVP fonctionnel et propre côté UI/UX. Les heuristiques
 * d'auto‑routage/placement sont simplifiées mais structurées pour évoluer.
 */

// --- Constantes physiques (métriques du jeu) --- //
const FOUNDATION_M = 8; // 8 m × 8 m
const DEFAULT_SCALE_PX_PER_M = 8; // 1 m = 8 px (zoom ajustable)

// Capacités des convoyeurs (items/min)
const BELT_SPEEDS = [60, 120, 270, 480, 780]; // Mk1..Mk5

// Dimensions (m)
const BUILDINGS = {
  smelter: { id: "smelter", name: "Smelter", w: 6, h: 9, inputs: 1, outputs: 1 },
  constructor: { id: "constructor", name: "Constructor", w: 8, h: 10, inputs: 1, outputs: 1 },
  assembler: { id: "assembler", name: "Assembler", w: 10, h: 15, inputs: 2, outputs: 1 },
  manufacturer: { id: "manufacturer", name: "Manufacturer", w: 18, h: 20, inputs: 4, outputs: 1 },
  splitter: { id: "splitter", name: "Splitter", w: 4, h: 4, inputs: 1, outputs: 3 },
  merger: { id: "merger", name: "Merger", w: 4, h: 4, inputs: 3, outputs: 1 },
};

type BuildingId = keyof typeof BUILDINGS;

// Petites recettes d'exemple (débits en items/min, 100% clock)
// NB: L'app peut importer un JSON complet plus tard.
const RECIPES: Record<string, any> = {
  // Minerais -> Lingots
  "Iron Ingot": {
    id: "iron_ingot",
    product: { name: "Iron Ingot", rate: 30 },
    inputs: [{ name: "Iron Ore", rate: 30 }],
    building: "smelter" as BuildingId,
  },
  "Copper Ingot": {
    id: "copper_ingot",
    product: { name: "Copper Ingot", rate: 30 },
    inputs: [{ name: "Copper Ore", rate: 30 }],
    building: "smelter" as BuildingId,
  },
  // Pièces simples
  "Iron Rod": {
    id: "iron_rod",
    product: { name: "Iron Rod", rate: 15 },
    inputs: [{ name: "Iron Ingot", rate: 15 }],
    building: "constructor" as BuildingId,
  },
  "Iron Plate": {
    id: "iron_plate",
    product: { name: "Iron Plate", rate: 20 },
    inputs: [{ name: "Iron Ingot", rate: 30 }],
    building: "constructor" as BuildingId,
  },
  "Screw": {
    id: "screw",
    product: { name: "Screw", rate: 40 },
    inputs: [{ name: "Iron Rod", rate: 10 }],
    building: "constructor" as BuildingId,
  },
  // Plaque renforcée — normale
  "Reinforced Iron Plate": {
    id: "rip_default",
    product: { name: "Reinforced Iron Plate", rate: 5 }, // /min
    inputs: [
      { name: "Iron Plate", rate: 30 },
      { name: "Screw", rate: 60 },
    ],
    building: "assembler" as BuildingId,
  },
  // Plaque renforcée — alternative (Bolted)
  "Reinforced Iron Plate (Bolted)": {
    id: "rip_bolted",
    product: { name: "Reinforced Iron Plate", rate: 15 },
    inputs: [
      { name: "Iron Plate", rate: 90 },
      { name: "Screw", rate: 250 },
    ],
    building: "assembler" as BuildingId,
    alt: true,
  },
};

// ---- Types de placement ---- //
interface PlacedEntity {
  id: string;
  type: BuildingId | "belt";
  x: number; // en mètres (origine en haut/gauche)
  y: number; // en mètres
  rotation: 0 | 90 | 180 | 270;
  meta?: any;
}

// Outils de dessin
const Tool = {
  SELECT: "select",
  PLACE: "place",
  BELT: "belt",
} as const;

export default function FactoryPlanner() {
  // --- Etat UI --- //
  const [scale, setScale] = useState(DEFAULT_SCALE_PX_PER_M); // px/m
  const [gridStep, setGridStep] = useState(1); // 1,2,4,8 (m)
  const [tool, setTool] = useState<typeof Tool[keyof typeof Tool]>(Tool.SELECT);
  const [palette, setPalette] = useState<BuildingId>("constructor");
  const [entities, setEntities] = useState<PlacedEntity[]>([]);

  // Planner state
  const [targetItem, setTargetItem] = useState<keyof typeof RECIPES | "">("");
  const [targetRate, setTargetRate] = useState(15); // items/min
  const [useAlt, setUseAlt] = useState(false);

  const boardRef = useRef<HTMLDivElement>(null);

  // --- Helpers --- //
  const toPx = (m: number) => Math.round(m * scale);

  function snapToGrid(m: number) {
    return Math.round(m / gridStep) * gridStep;
  }

  function addEntity(e: Omit<PlacedEntity, "id">) {
    setEntities((prev) => [
      ...prev,
      { ...e, id: Math.random().toString(36).slice(2, 9) },
    ]);
  }

  function removeEntity(id: string) {
    setEntities((prev) => prev.filter((p) => p.id !== id));
  }

  // --- Interaction: clic sur la grille --- //
  function handleBoardClick(ev: React.MouseEvent) {
    if (!boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) / scale; // en m
    const my = (ev.clientY - rect.top) / scale;
    const x = snapToGrid(mx);
    const y = snapToGrid(my);

    if (tool === Tool.PLACE) {
      const spec = BUILDINGS[palette];
      addEntity({ type: palette, x, y, rotation: 0, meta: { w: spec.w, h: spec.h } });
    }
  }

  // --- Planificateur: calcule un graphe de production --- //
  type Node = {
    name: string;
    recipeKey: string;
    building: BuildingId;
    outputRate: number; // /min
    machines: number;
    inputs: { name: string; rate: number; from?: Node }[];
  };

  function chooseRecipe(name: string, preferAlt: boolean): string | null {
    const entries = Object.entries(RECIPES).filter(([k]) => k.startsWith(name));
    if (entries.length === 0) return null;
    if (!preferAlt) {
      const std = entries.find(([k]) => !RECIPES[k].alt);
      return std ? std[0] : entries[0][0];
    }
    const alt = entries.find(([k]) => RECIPES[k].alt);
    return alt ? alt[0] : entries[0][0];
  }

  function buildChain(productName: string, rate: number, preferAlt: boolean): Node | null {
    const key = chooseRecipe(productName, preferAlt);
    if (!key) return null;
    const r = RECIPES[key];
    const machines = rate / r.product.rate;

    const node: Node = {
      name: r.product.name,
      recipeKey: key,
      building: r.building,
      outputRate: rate,
      machines,
      inputs: r.inputs.map((inp: any) => ({ name: inp.name, rate: (rate * inp.rate) / r.product.rate })),
    };

    // Recurse only if inputs themselves are craftables present in RECIPES
    node.inputs = node.inputs.map((inp) => {
      if (RECIPES[inp.name] || chooseRecipe(inp.name, preferAlt)) {
        const sub = buildChain(inp.name, inp.rate, preferAlt);
        return { ...inp, from: sub || undefined };
      }
      return inp;
    });

    return node;
  }

  // Déduction du Mk de convoyeur minimal pour un flux donné
  function minBeltMkFor(rate: number) {
    const idx = BELT_SPEEDS.findIndex((cap) => rate <= cap);
    return idx === -1 ? 5 : idx + 1; // Mk1..Mk5
  }

  // Layout automatique simple par "bandes"
  function autoLayout(root: Node, originX = 0, originY = 0) {
    // Calcule des "profondeurs" (distance à la racine)
    const layers: Node[][] = [];

    function traverse(n: Node, depth: number) {
      if (!layers[depth]) layers[depth] = [];
      if (!layers[depth].includes(n)) layers[depth].push(n);
      n.inputs.forEach((i) => {
        if (i.from) traverse(i.from, depth + 1);
      });
    }
    traverse(root, 0);

    // Place machines par paquets, alignées sur la grille 8m en X, 4m en Y
    let y = originY;
    const placements: PlacedEntity[] = [];

    layers
      .slice()
      .reverse() // entrées en bas, produit final en haut
      .forEach((nodes, li) => {
        let x = originX;
        nodes.forEach((node) => {
          const spec = BUILDINGS[node.building];
          const count = Math.ceil(node.machines * 100) / 100; // garder info décimale

          const spacing = 2; // 2 m entre bâtiments
          const perRow = Math.max(1, Math.floor((FOUNDATION_M * 6) / (spec.w + spacing))); // ~6 dalles de large
          let placed = 0;
          let row = 0;

          while (placed < Math.ceil(count)) {
            const col = placed % perRow;
            row = Math.floor(placed / perRow);
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

          // espace horizontal entre paquets
          x += (perRow * (spec.w + spacing)) + 8; // +1 fondation
        });
        // espace vertical entre couches
        y += 12; // 12 m
      });

    return placements;
  }

  // Rendu d'une entité
  function EntityCard({ e, selected, onClick, onRemove }: { e: PlacedEntity; selected?: boolean; onClick?: () => void; onRemove?: () => void; }) {
    const dims = e.type === "belt" ? { w: 0.2, h: 0.2 } : { w: e.meta?.w ?? 2, h: e.meta?.h ?? 2 };
    return (
      <div
        className={`absolute rounded-2xl shadow-md border ${selected ? "border-amber-500" : "border-zinc-700"} bg-zinc-800/80 backdrop-blur-sm hover:shadow-lg`}
        title={e.meta?.node ? tooltipForNode(e.meta.node) : BUILDINGS[e.type as BuildingId]?.name}
        style={{ left: toPx(e.x), top: toPx(e.y), width: toPx(dims.w), height: toPx(dims.h) }}
        onClick={onClick}
      >
        <div className="text-[10px] leading-tight p-1 text-zinc-200 flex items-center justify-between">
          <span>{(BUILDINGS as any)[e.type]?.name ?? "Belt"}</span>
          <button className="opacity-70 hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); onRemove?.(); }}>✕</button>
        </div>
        {e.meta?.node && (
          <div className="px-2 pb-1 text-[10px] text-zinc-300">
            <div>{e.meta.node.name} · {round2(e.meta.node.outputRate)}/min</div>
            <div>{round2(e.meta.node.machines)}×</div>
          </div>
        )}
      </div>
    );
  }

  function round2(n: number) { return Math.round(n * 100) / 100; }

  function tooltipForNode(n: Node) {
    const inputs = n.inputs.map(i => `${round2(i.rate)}/min ${i.name}`).join(" + ");
    const belt = `Belt ≥ Mk${minBeltMkFor(n.outputRate)}`;
    return `${n.name}: ${round2(n.outputRate)}/min\n${inputs}\n${belt}`;
  }

  // Déclencher le planificateur
  function runPlanner() {
    if (!targetItem) return;
    const key = useAlt ? chooseRecipe(targetItem as string, true) : chooseRecipe(targetItem as string, false);
    if (!key) return;
    const product = RECIPES[key].product.name as string;
    const chain = buildChain(product, targetRate, useAlt);
    if (!chain) return;
    const placement = autoLayout(chain, 8, 8);
    setEntities((prev) => prev.filter(e => !e.meta?.node).concat(placement));
  }

  // UI — Légendes fondations
  const foundationLines = useMemo(() => {
    const sizePx = toPx(FOUNDATION_M);
    const subPx = toPx(gridStep);
    return { sizePx, subPx };
  }, [scale, gridStep]);

  // Export JSON (plan)
  function exportPlan() {
    const data = {
      meta: { createdAt: new Date().toISOString(), scale, gridStep },
      entities,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `satisfactory-plan-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    
    <div className="w-full h-full bg-zinc-900 text-zinc-100">
      <header className="flex items-center gap-3 p-3 border-b border-zinc-800 sticky top-0 z-20 bg-zinc-900/80 backdrop-blur">
        <h1 className="text-xl font-semibold">Satisfactory Factory Planner — MVP</h1>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="opacity-70">Zoom</span>
          <input type="range" min={4} max={20} step={1} value={scale} onChange={(e) => setScale(parseInt(e.target.value))} />
          <span className="w-10 text-right">{scale}px/m</span>
          <span className="ml-4 opacity-70">Snap</span>
          <select className="bg-zinc-800 rounded-md px-2 py-1" value={gridStep} onChange={(e) => setGridStep(parseInt(e.target.value))}>
            <option value={1}>1 m</option>
            <option value={2}>2 m</option>
            <option value={4}>4 m</option>
            <option value={8}>8 m (dalle)</option>
          </select>
          <button className={`ml-4 px-3 py-1 rounded-md border ${tool===Tool.SELECT?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`} onClick={() => setTool(Tool.SELECT)}>Sélection</button>
          <button className={`px-3 py-1 rounded-md border ${tool===Tool.PLACE?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`} onClick={() => setTool(Tool.PLACE)}>Placer</button>
          {/* Belt tool réservé aux itérations futures */}
          <button className={`px-3 py-1 rounded-md border ${tool===Tool.BELT?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`} onClick={() => setTool(Tool.BELT)} disabled>Convoyeur (bientôt)</button>
          <button className="ml-4 px-3 py-1 rounded-md border border-zinc-700 hover:border-zinc-500" onClick={exportPlan}>Exporter JSON</button>
        </div>
      </header>

      <div className="grid grid-cols-[280px_1fr_320px] h-[calc(100vh-56px)]">
        {/* Palette */}
        <aside className="border-r border-zinc-800 p-3">
          <h2 className="text-sm uppercase tracking-wider opacity-70 mb-3">Palette</h2>
          <div className="grid grid-cols-2 gap-2">
            {Object.values(BUILDINGS).map((b) => (
              <button key={b.id} onClick={() => { setPalette(b.id as BuildingId); setTool(Tool.PLACE); }} className={`rounded-xl border p-3 text-left hover:border-amber-400 ${palette===b.id?"border-amber-400 bg-amber-400/10":"border-zinc-700"}`}>
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

        {/* Plateau (grille) */}
        <main className="relative overflow-auto" onClick={handleBoardClick}>
          <div ref={boardRef} className="relative min-w-[2000px] min-h-[1200px]" style={{ backgroundSize: `${foundationLines.subPx}px ${foundationLines.subPx}px, ${toPx(FOUNDATION_M)}px ${toPx(FOUNDATION_M)}px`, backgroundImage: `linear-gradient(to right, rgba(250,204,21,0.15) 1px, transparent 1px), linear-gradient(to bottom, rgba(250,204,21,0.15) 1px, transparent 1px), linear-gradient(to right, rgba(250,204,21,0.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(250,204,21,0.25) 1px, transparent 1px)`, backgroundPosition: `0 0, 0 0, 0 0, 0 0`, backgroundRepeat: "repeat, repeat, repeat, repeat" }}>
            {/* Axes visuels */}
            <div className="absolute left-0 top-0 p-2 text-xs opacity-70">Origine (0,0) m</div>

            {/* Entités */}
            {entities.map((e) => (
              <EntityCard key={e.id} e={e} onRemove={() => removeEntity(e.id)} />
            ))}
          </div>
        </main>

        {/* Planificateur */}
        <aside className="border-l border-zinc-800 p-3 space-y-3">
          <h2 className="text-sm uppercase tracking-wider opacity-70">Planificateur</h2>
          <div className="space-y-2">
            <label className="text-sm">Produit cible</label>
            <select className="w-full bg-zinc-800 rounded-md px-2 py-2" value={targetItem} onChange={(e)=> setTargetItem(e.target.value as any)}>
              <option value="">— Choisir —</option>
              {Object.keys(RECIPES).filter(k=>!RECIPES[k].alt).map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <label className="text-sm">Débit (items/min)</label>
              <input className="bg-zinc-800 rounded-md px-2 py-1 w-24" type="number" min={1} value={targetRate} onChange={(e)=> setTargetRate(parseFloat(e.target.value))} />
            </div>
            {targetItem?.toString().includes("Reinforced Iron Plate") && (
              <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={useAlt} onChange={(e)=> setUseAlt(e.target.checked)} /> Utiliser recette alternative (Bolted)</label>
            )}
            <button onClick={runPlanner} className="w-full rounded-md border border-amber-400 bg-amber-400/10 py-2 hover:bg-amber-400/20">Générer le layout</button>
          </div>

          <div className="pt-4 border-t border-zinc-800 text-sm space-y-2">
            <h3 className="uppercase tracking-wider opacity-70">Notes</h3>
            <ul className="list-disc ml-5 space-y-1 opacity-90">
              <li>Snap 1/2/4/8 m conforme aux fondations.</li>
              <li>Les tailles machines & capacités de convoyeurs sont respectées.</li>
              <li>Le JSON d'export peut être ré-importé (à implémenter).</li>
              <li>Prochaines itérations : routage auto des convoyeurs, ports I/O exacts, pylônes & électricité, import complet des recettes.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
