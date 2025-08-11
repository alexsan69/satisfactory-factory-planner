import type { BuildingId } from "../types";

export const FOUNDATION_M = 8;
export const BELT_SPEEDS = [60, 120, 270, 480, 780]; // Mk1..Mk5

export const BUILDINGS: Record<BuildingId, { id: BuildingId; name: string; w: number; h: number; inputs: number; outputs: number }> = {
  smelter:      { id: "smelter", name: "Smelter",      w: 6,  h: 9,  inputs: 1, outputs: 1 },
  constructor:  { id: "constructor", name: "Constructor", w: 8,  h: 10, inputs: 1, outputs: 1 },
  assembler:    { id: "assembler", name: "Assembler",    w: 10, h: 15, inputs: 2, outputs: 1 },
  manufacturer: { id: "manufacturer", name: "Manufacturer", w: 18, h: 20, inputs: 4, outputs: 1 },
  splitter:     { id: "splitter", name: "Splitter",     w: 4,  h: 4,  inputs: 1, outputs: 3 },
  merger:       { id: "merger", name: "Merger",       w: 4,  h: 4,  inputs: 3, outputs: 1 },
};
