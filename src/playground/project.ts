/**
 * Assembles the playground routing tree, mirroring the HttpArena `genhttp-11` / `fishcake`
 * entries (in-memory data; no TLS/compression/static/websocket yet).
 */
import { Content, Resource } from "../modules/io/index.ts";
import { Layout, type LayoutBuilder } from "../modules/layouting/index.ts";
import { Service } from "../modules/webservices/index.ts";
import { Baseline, Crud, JsonService, Upload } from "./services.ts";

export function createApp(): LayoutBuilder {
  return Layout.create()
    .add("pipeline", Content.from(Resource.fromString("ok")))
    .add("baseline11", Service.from(Baseline))
    .add("baseline2", Service.from(Baseline))
    .add("upload", Service.from(Upload))
    .add("json", Service.from(JsonService))
    .add("crud", Layout.create().add("items", Service.from(Crud)));
}
