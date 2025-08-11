export type BuildingId = "smelter" | "constructor" | "assembler" | "manufacturer" | "splitter" | "merger";

export interface Ingredient { name: string; rate: number } // /min
export interface Recipe {
  id: string;
  product: { name: string; rate: number }; // /min
  inputs: Ingredient[];
  building: BuildingId;
  alt?: boolean;
}
