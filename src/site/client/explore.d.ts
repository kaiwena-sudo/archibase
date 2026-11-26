// Types for the browser script, used by its unit tests.
export const esc: (s: unknown) => string;
export function colourClass(type: string): string;
export function dominantAngle(polys: number[][][][]): number;
export function planSvg(v: unknown, plan?: unknown, opts?: { labels?: boolean }): string;
export function parseChallenge(header: string): any;
export function makeAuthorization(accepted: any, from: string, nowSec: number, nonceBytes: Uint8Array): Record<string, string>;
export function paymentTypedData(accepted: any, authorization: Record<string, string>): any;
export function buildPayment(challenge: any, accepted: any, authorization: any, signature: string): any;
export const encodePayment: (payment: unknown) => string;
export function browserWallet(ethereum: { request(args: { method: string; params?: unknown[] }): Promise<any> }): {
  connect(): Promise<string>;
  ensureChain(chainId: number): Promise<void>;
  signTypedData(from: string, td: any): Promise<string>;
};
export function fetchPaid(url: string, opts: {
  apiKey?: string;
  wallet?: { connect(): Promise<string>; ensureChain(id: number): Promise<void>; signTypedData(from: string, td: any): Promise<string> } | null;
  network: string;
  maxUsd?: number;
  onStatus?: (text: string) => void;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}): Promise<Response>;
