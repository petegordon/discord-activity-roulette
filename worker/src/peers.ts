export type Attachment = { id: string; joinedAt: number; lastTwist?: number; role?: "player" | "remote" };

/**
 * Connection order decides the host: the earliest *player*. Spinner remotes
 * are listed separately and can never be host (see SPINNER-REMOTE.md).
 * Attachments from before roles existed count as players.
 */
export function splitPeers<T extends { att: Attachment }>(sockets: T[]): { players: T[]; remotes: T[] } {
  const ordered = [...sockets].sort((a, b) => a.att.joinedAt - b.att.joinedAt || a.att.id.localeCompare(b.att.id));
  return {
    players: ordered.filter((s) => s.att.role !== "remote"),
    remotes: ordered.filter((s) => s.att.role === "remote"),
  };
}
