/**
 * Seagreen playground server (HttpArena-shaped). Run: `bun run src/playground/main.ts`.
 *
 *   GET  /pipeline
 *   GET  /baseline11?a=&b=     POST /baseline11?a=&b=  (body: a number)
 *   GET  /baseline2?a=&b=
 *   GET  /json/:count?m=
 *   POST /upload               (any body)
 *   GET  /crud/items?category=&page=&limit=
 *   GET  /crud/items/:id       POST /crud/items        PUT /crud/items/:id
 */
import { Host } from "../engine/internal/index.ts";
import { createApp } from "./project.ts";

const port = Number(process.env.PORT ?? 8080);
console.log(`Seagreen playground on :${port}`);
await Host.create().handler(createApp()).port(port).run();
