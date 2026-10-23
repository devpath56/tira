// Types for drag.mjs (plain JS, shared with the browser).
export declare const RUNS_AT_ONCE: Set<string>;
export function moveFor(moves: Record<string, string>, key: string, from: string, to: string): string | undefined;
export function wireDrag(act: (type: string, id: string, event: string, now: boolean) => void): void;
