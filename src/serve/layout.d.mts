// Types for layout.mjs (plain JS, shared with the browser).
export interface LayoutNode { key: string; parent?: string | undefined }
export interface Point { x: number; y: number; stack?: boolean }
export interface View { x: number; y: number; s: number }
export declare const STACK: { dx: number; top: number; pitch: number; spine: number; compact: number; few: number; most: number; many: number };
export declare const G: { node: number; box: number; gap: number; level: number; top: number; side: number; bottom: number };
export declare const fx: (n: number) => string;
export declare function layout(nodes: readonly LayoutNode[], folded?: ReadonlySet<string>): { at: Map<string, Point>; width: number; height: number };
export declare const treePath: (p: Point, c: Point) => string;
export declare const foundPath: (a: Point, b: Point) => string;
export declare function subtree(nodes: readonly LayoutNode[], key: string): string[];
export declare function finishedBranches(nodes: readonly LayoutNode[], isClosed: (key: string) => boolean): string[];
export declare const ZOOM: { min: number; max: number };
export declare function zoomAt(view: View, factor: number, cx: number, cy: number): View;
export declare function fitView(width: number, height: number, vw: number, vh: number, pad?: number): View;
export declare const centreOn: (p: Point, s: number, vw: number, vh: number) => View;
export declare const FAR: number;
export declare function isFar(s: number): boolean;
export declare function branchSpans(nodes: readonly LayoutNode[], at: ReadonlyMap<string, Point>): Map<string, [number, number]>;
export declare const LABEL: { min: number; deep: number };
export declare function labelFits(span: readonly [number, number], s: number, depth: number): boolean;
export declare const MINI: { w: number; h: number };
export declare function miniScale(width: number, height: number, maxW?: number, maxH?: number): number;
export declare function viewRect(view: View, vw: number, vh: number): { x: number; y: number; w: number; h: number };
export declare function centreAt(x: number, y: number, s: number, vw: number, vh: number): View;
export declare function ease(t: number): number;
export declare function viewBetween(a: View, b: View, t: number, vw: number, vh: number): View;
export declare function placesBetween(nodes: readonly LayoutNode[], from: ReadonlyMap<string, Point>, to: ReadonlyMap<string, Point>, t: number): { at: Map<string, Point>; fade: Map<string, number> };
