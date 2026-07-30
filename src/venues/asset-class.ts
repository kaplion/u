import type { VenueName } from "../config/config.js";

export type AssetClass = "crypto" | "us_equity" | "forex";

export interface SymbolSpec {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly contractSize: number;
  readonly tickSize: number;
  readonly lotStep: number;
  readonly pipSize?: number;
}

export function assetClassForVenue(venue: VenueName): AssetClass {
  switch (venue) {
    case "binance":
      return "crypto";
    case "alpaca":
      return "us_equity";
    case "ig":
      return "forex";
  }
}

export function normalizeSymbol(symbol: string, assetClass: AssetClass): string {
  const upper = symbol.trim().toUpperCase();
  if (assetClass === "forex") {
    return upper.replace(/[^A-Z]/g, "");
  }
  return upper;
}

export function symbolSpecForVenueSymbol(symbol: string, venue: VenueName): SymbolSpec {
  const assetClass = assetClassForVenue(venue);
  const canonical = normalizeSymbol(symbol, assetClass);
  if (assetClass === "forex") {
    const quote = canonical.slice(3);
    const pipSize = quote === "JPY" ? 0.01 : 0.0001;
    const tickSize = quote === "JPY" ? 0.001 : 0.00001;
    return {
      symbol: canonical,
      assetClass,
      contractSize: 100_000,
      tickSize,
      lotStep: 0.01,
      pipSize,
    };
  }
  if (assetClass === "us_equity") {
    return {
      symbol: canonical,
      assetClass,
      contractSize: 1,
      tickSize: 0.01,
      lotStep: 0.0001,
    };
  }
  return {
    symbol: canonical,
    assetClass,
    contractSize: 1,
    tickSize: 0.01,
    lotStep: 0.00000001,
  };
}

export function orderNotional(quantity: number, price: number, spec: SymbolSpec): number {
  return Math.abs(quantity) * price * spec.contractSize;
}

export function forexPipValue(price: number, spec: SymbolSpec): number | undefined {
  if (spec.assetClass !== "forex" || spec.pipSize === undefined || price <= 0) return undefined;
  const base = spec.symbol.slice(0, 3);
  const quote = spec.symbol.slice(3, 6);
  if (quote === "USD") return spec.contractSize * spec.pipSize;
  if (base === "USD") return (spec.contractSize * spec.pipSize) / price;
  return spec.contractSize * spec.pipSize;
}
