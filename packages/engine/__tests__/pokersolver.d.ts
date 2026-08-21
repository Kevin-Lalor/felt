// Minimal typings for the test-only oracle. pokersolver never appears in src/.
declare module 'pokersolver' {
  export class Hand {
    static solve(cards: string[]): Hand;
    static winners(hands: Hand[]): Hand[];
    name: string;
    rank: number;
    descr: string;
  }
}
