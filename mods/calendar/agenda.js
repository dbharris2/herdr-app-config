import { appHome, exec } from "herdr";

// Shared by the panel and status copies of this mod; never persisted.
let cached = null, fetchedAt = 0, pending = null, generation = 0;
export function invalidateAgenda() { cached = null; fetchedAt = 0; pending = null; generation++; }
export async function agenda(force = false) {
  if (pending) return pending;
  if (!force && cached && Date.now() - fetchedAt < 300000) return cached;
  const currentGeneration = generation;
  const request = (async () => {
    const result = await exec("node", [appHome() + "/mods/calendar/agenda.cjs"], { timeout: 60000 });
    if (result.code !== 0) throw new Error("Could not load calendar. Check your connection and try again.");
    const data = JSON.parse(result.stdout);
    if (generation === currentGeneration) { cached = data; fetchedAt = Date.now(); }
    return data;
  })();
  pending = request;
  try { return await request; } finally { if (pending === request) pending = null; }
}
